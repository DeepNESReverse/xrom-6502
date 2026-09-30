/**
 * The NES's 6502, instruction by instruction, counting cycles.
 *
 * Every read and write goes through the `Bus`, so the caller decides what the
 * address space is — RAM, a cartridge, an APU. `step()` runs one instruction
 * and returns how many cycles it took, with the page-crossing and branch
 * penalties the hardware charges, which is what lets a caller place a write at
 * the right moment inside a frame.
 *
 * All 256 opcodes, the undocumented ones included (games and music drivers use
 * them). No decimal mode: the 2A03 has the D flag but no BCD arithmetic.
 * Checked against Tom Harte's SingleStepTests for the NES 6502 — final
 * registers, memory and cycle counts for every opcode.
 */

import { OPCODES, type Opcode } from './opcodes.js';

export interface Bus {
  read(address: number): number;
  write(address: number, value: number): void;
}

export const FLAG_C = 0x01;
export const FLAG_Z = 0x02;
export const FLAG_I = 0x04;
export const FLAG_D = 0x08;
export const FLAG_B = 0x10;
export const FLAG_U = 0x20;
export const FLAG_V = 0x40;
export const FLAG_N = 0x80;

/**
 * The value the unstable immediates (ANE, LXA) OR into A. It differs between
 * chips and even with temperature; this is the one SingleStepTests use.
 */
const MAGIC = 0xee;

export class Cpu6502 {
  a = 0;
  x = 0;
  y = 0;
  /** Stack pointer, into page one. */
  s = 0xfd;
  p = FLAG_I | FLAG_U;
  pc = 0;
  /** Cycles run since construction. */
  cycles = 0;
  /** Set by a JAM opcode: the chip stops until reset. */
  jammed = false;

  constructor(private readonly bus: Bus) {}

  /** Start from the reset vector, as power-on or the reset button does. */
  reset() {
    this.s = (this.s - 3) & 0xff;
    this.p |= FLAG_I;
    this.pc = this.word(0xfffc);
    this.jammed = false;
    this.cycles += 7;
  }

  /** A non-maskable interrupt — on the NES, the start of vertical blank. */
  nmi() {
    this.interrupt(0xfffa, false);
  }

  /** An interrupt request; ignored while the I flag is set. */
  irq() {
    if (!(this.p & FLAG_I)) this.interrupt(0xfffe, false);
  }

  private interrupt(vector: number, brk: boolean) {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    this.push((this.p | FLAG_U | (brk ? FLAG_B : 0)) & (brk ? 0xff : ~FLAG_B));
    this.p |= FLAG_I;
    this.pc = this.word(vector);
    this.cycles += 7;
  }

  /** Run one instruction; returns the cycles it took. */
  step(): number {
    if (this.jammed) {
      this.cycles += 1;
      return 1;
    }
    const op = OPCODES[this.read(this.pc)];
    const at = (this.pc + 1) & 0xffff;
    this.pc = (this.pc + op.length) & 0xffff;
    const extra = this.execute(op, at);
    const cycles = op.cycles + extra;
    this.cycles += cycles;
    return cycles;
  }

  /** Run until at least `cycles` more have passed; returns how many did. */
  run(cycles: number): number {
    let done = 0;
    while (done < cycles && !this.jammed) done += this.step();
    return done;
  }

  // ——— the bus ———

  private read(address: number) {
    return this.bus.read(address & 0xffff) & 0xff;
  }
  private write(address: number, value: number) {
    this.bus.write(address & 0xffff, value & 0xff);
  }
  private word(address: number) {
    return this.read(address) | (this.read((address + 1) & 0xffff) << 8);
  }
  /** A zero-page pointer: the high byte wraps within page zero. */
  private zpWord(address: number) {
    return this.read(address & 0xff) | (this.read((address + 1) & 0xff) << 8);
  }
  private push(value: number) {
    this.write(0x100 | this.s, value);
    this.s = (this.s - 1) & 0xff;
  }
  private pull() {
    this.s = (this.s + 1) & 0xff;
    return this.read(0x100 | this.s);
  }

  // ——— flags ———

  private flag(mask: number, on: boolean) {
    this.p = on ? this.p | mask : this.p & ~mask;
  }
  private nz(value: number) {
    const v = value & 0xff;
    this.p = (this.p & ~(FLAG_Z | FLAG_N)) | (v === 0 ? FLAG_Z : 0) | (v & FLAG_N);
    return v;
  }

  // ——— addressing ———

  /** Set by `operand` when indexing crossed a page. */
  private crossed = false;
  /** The un-indexed base of the last abx/aby/izy operand, for the SH* family. */
  private base = 0;

  /** Effective address of the operand for every mode that names one. */
  private operand(op: Opcode, at: number): number {
    this.crossed = false;
    switch (op.mode) {
      case 'imm':
        return at;
      case 'zp':
        return this.read(at);
      case 'zpx':
        return (this.read(at) + this.x) & 0xff;
      case 'zpy':
        return (this.read(at) + this.y) & 0xff;
      case 'abs':
        return this.word(at);
      case 'abx':
      case 'aby': {
        const base = this.word(at);
        const address = (base + (op.mode === 'abx' ? this.x : this.y)) & 0xffff;
        this.base = base;
        this.crossed = (base & 0xff00) !== (address & 0xff00);
        return address;
      }
      case 'izx':
        return this.zpWord(this.read(at) + this.x);
      case 'izy': {
        const base = this.zpWord(this.read(at));
        const address = (base + this.y) & 0xffff;
        this.base = base;
        this.crossed = (base & 0xff00) !== (address & 0xff00);
        return address;
      }
      case 'ind': {
        // The famous bug: a pointer at $xxFF takes its high byte from $xx00.
        const pointer = this.word(at);
        const high = (pointer & 0xff00) | ((pointer + 1) & 0xff);
        return this.read(pointer) | (this.read(high) << 8);
      }
      default:
        return 0;
    }
  }

  // ——— arithmetic ———

  private adc(m: number) {
    const sum = this.a + m + (this.p & FLAG_C);
    this.flag(FLAG_C, sum > 0xff);
    this.flag(FLAG_V, (~(this.a ^ m) & (this.a ^ sum) & 0x80) !== 0);
    this.a = this.nz(sum);
  }
  private compare(register: number, m: number) {
    this.flag(FLAG_C, register >= m);
    this.nz(register - m);
  }
  private asl(m: number) {
    this.flag(FLAG_C, (m & 0x80) !== 0);
    return this.nz(m << 1);
  }
  private lsr(m: number) {
    this.flag(FLAG_C, (m & 1) !== 0);
    return this.nz(m >> 1);
  }
  private rol(m: number) {
    const carry = this.p & FLAG_C;
    this.flag(FLAG_C, (m & 0x80) !== 0);
    return this.nz((m << 1) | carry);
  }
  private ror(m: number) {
    const carry = this.p & FLAG_C;
    this.flag(FLAG_C, (m & 1) !== 0);
    return this.nz((m >> 1) | (carry << 7));
  }
  private branch(condition: boolean, at: number): number {
    if (!condition) return 0;
    const offset = this.read(at);
    const target = (this.pc + (offset < 0x80 ? offset : offset - 0x100)) & 0xffff;
    const extra = (target & 0xff00) !== (this.pc & 0xff00) ? 2 : 1;
    this.pc = target;
    return extra;
  }
  /** The SH* family: store `value & (high byte of base + 1)`, which on a page cross also bends the address. */
  private shStore(value: number, address: number) {
    const stored = value & (((this.base >> 8) + 1) & 0xff);
    const target = this.crossed ? (stored << 8) | (address & 0xff) : address;
    this.write(target, stored);
  }

  /** Run `op` with its operand bytes at `at`; returns extra cycles. */
  private execute(op: Opcode, at: number): number {
    const mode = op.mode;
    const penalty = () => (op.pagePenalty && this.crossed ? 1 : 0);
    // Read-modify-write helper: apply `f` to the operand in A or in memory.
    const rmw = (f: (m: number) => number) => {
      if (mode === 'acc') {
        this.a = f(this.a);
        return 0;
      }
      const address = this.operand(op, at);
      const result = f(this.read(address));
      this.write(address, result);
      return result;
    };
    const load = () => this.read(this.operand(op, at));

    // Numbered cases, so the engine can jump straight to one instead of
    // comparing the mnemonic against each in turn.
    switch (op.kind) {
      // loads and stores
      case 0 /* LDA */:
        this.a = this.nz(load());
        return penalty();
      case 1 /* LDX */:
        this.x = this.nz(load());
        return penalty();
      case 2 /* LDY */:
        this.y = this.nz(load());
        return penalty();
      case 3 /* LAX */:
        this.a = this.x = this.nz(load());
        return penalty();
      case 4 /* STA */:
        this.write(this.operand(op, at), this.a);
        return 0;
      case 5 /* STX */:
        this.write(this.operand(op, at), this.x);
        return 0;
      case 6 /* STY */:
        this.write(this.operand(op, at), this.y);
        return 0;
      case 7 /* SAX */:
        this.write(this.operand(op, at), this.a & this.x);
        return 0;

      // arithmetic and logic
      case 8 /* ADC */:
        this.adc(load());
        return penalty();
      case 9 /* SBC */:
        this.adc(load() ^ 0xff);
        return penalty();
      case 10 /* AND */:
        this.a = this.nz(this.a & load());
        return penalty();
      case 11 /* ORA */:
        this.a = this.nz(this.a | load());
        return penalty();
      case 12 /* EOR */:
        this.a = this.nz(this.a ^ load());
        return penalty();
      case 13 /* CMP */:
        this.compare(this.a, load());
        return penalty();
      case 14 /* CPX */:
        this.compare(this.x, load());
        return 0;
      case 15 /* CPY */:
        this.compare(this.y, load());
        return 0;
      case 16 /* BIT */: {
        const m = load();
        this.flag(FLAG_Z, (this.a & m) === 0);
        this.p = (this.p & 0x3f) | (m & 0xc0);
        return 0;
      }

      // shifts and increments
      case 17 /* ASL */:
        rmw((m) => this.asl(m));
        return 0;
      case 18 /* LSR */:
        rmw((m) => this.lsr(m));
        return 0;
      case 19 /* ROL */:
        rmw((m) => this.rol(m));
        return 0;
      case 20 /* ROR */:
        rmw((m) => this.ror(m));
        return 0;
      case 21 /* INC */:
        rmw((m) => this.nz(m + 1));
        return 0;
      case 22 /* DEC */:
        rmw((m) => this.nz(m - 1));
        return 0;
      case 23 /* INX */:
        this.x = this.nz(this.x + 1);
        return 0;
      case 24 /* INY */:
        this.y = this.nz(this.y + 1);
        return 0;
      case 25 /* DEX */:
        this.x = this.nz(this.x - 1);
        return 0;
      case 26 /* DEY */:
        this.y = this.nz(this.y - 1);
        return 0;

      // transfers and the stack
      case 27 /* TAX */:
        this.x = this.nz(this.a);
        return 0;
      case 28 /* TAY */:
        this.y = this.nz(this.a);
        return 0;
      case 29 /* TXA */:
        this.a = this.nz(this.x);
        return 0;
      case 30 /* TYA */:
        this.a = this.nz(this.y);
        return 0;
      case 31 /* TSX */:
        this.x = this.nz(this.s);
        return 0;
      case 32 /* TXS */:
        this.s = this.x;
        return 0;
      case 33 /* PHA */:
        this.push(this.a);
        return 0;
      case 34 /* PHP */:
        this.push(this.p | FLAG_B | FLAG_U);
        return 0;
      case 35 /* PLA */:
        this.a = this.nz(this.pull());
        return 0;
      case 36 /* PLP */:
        this.p = (this.pull() & ~FLAG_B) | FLAG_U;
        return 0;

      // flags
      case 37 /* CLC */:
        this.p &= ~FLAG_C;
        return 0;
      case 38 /* SEC */:
        this.p |= FLAG_C;
        return 0;
      case 39 /* CLI */:
        this.p &= ~FLAG_I;
        return 0;
      case 40 /* SEI */:
        this.p |= FLAG_I;
        return 0;
      case 41 /* CLV */:
        this.p &= ~FLAG_V;
        return 0;
      case 42 /* CLD */:
        this.p &= ~FLAG_D;
        return 0;
      case 43 /* SED */:
        this.p |= FLAG_D;
        return 0;

      // flow
      case 44 /* BPL */:
        return this.branch(!(this.p & FLAG_N), at);
      case 45 /* BMI */:
        return this.branch((this.p & FLAG_N) !== 0, at);
      case 46 /* BVC */:
        return this.branch(!(this.p & FLAG_V), at);
      case 47 /* BVS */:
        return this.branch((this.p & FLAG_V) !== 0, at);
      case 48 /* BCC */:
        return this.branch(!(this.p & FLAG_C), at);
      case 49 /* BCS */:
        return this.branch((this.p & FLAG_C) !== 0, at);
      case 50 /* BNE */:
        return this.branch(!(this.p & FLAG_Z), at);
      case 51 /* BEQ */:
        return this.branch((this.p & FLAG_Z) !== 0, at);
      case 52 /* JMP */:
        this.pc = this.operand(op, at);
        return 0;
      case 53 /* JSR */: {
        const target = this.word(at);
        const back = (this.pc - 1) & 0xffff;
        this.push(back >> 8);
        this.push(back & 0xff);
        this.pc = target;
        return 0;
      }
      case 54 /* RTS */: {
        const low = this.pull();
        this.pc = ((low | (this.pull() << 8)) + 1) & 0xffff;
        return 0;
      }
      case 55 /* RTI */: {
        this.p = (this.pull() & ~FLAG_B) | FLAG_U;
        const low = this.pull();
        this.pc = low | (this.pull() << 8);
        return 0;
      }
      case 56 /* BRK */:
        // The byte after BRK is padding: the return address skips it.
        this.pc = (this.pc + 1) & 0xffff;
        this.interrupt(0xfffe, true);
        this.cycles -= 7; // counted by the table
        return 0;
      case 57 /* NOP */:
        if (mode !== 'imp') load();
        return penalty();
      case 58 /* JAM */:
        this.jammed = true;
        this.pc = (this.pc - 1) & 0xffff;
        return 0;

      // undocumented: read-modify-write combinations
      case 59 /* SLO */:
        this.a = this.nz(this.a | rmw((m) => this.asl(m)));
        return 0;
      case 60 /* RLA */:
        this.a = this.nz(this.a & rmw((m) => this.rol(m)));
        return 0;
      case 61 /* SRE */:
        this.a = this.nz(this.a ^ rmw((m) => this.lsr(m)));
        return 0;
      case 62 /* RRA */:
        this.adc(rmw((m) => this.ror(m)));
        return 0;
      case 63 /* DCP */:
        this.compare(this.a, rmw((m) => (m - 1) & 0xff));
        return 0;
      case 64 /* ISC */:
        this.adc(rmw((m) => (m + 1) & 0xff) ^ 0xff);
        return 0;

      // undocumented: immediates
      case 65 /* ANC */:
        this.a = this.nz(this.a & load());
        this.flag(FLAG_C, (this.a & 0x80) !== 0);
        return 0;
      case 66 /* ALR */:
        this.a = this.lsr(this.a & load());
        return 0;
      case 67 /* ARR */: {
        const v = this.a & load();
        this.a = this.nz((v >> 1) | ((this.p & FLAG_C) << 7));
        this.flag(FLAG_C, (this.a & 0x40) !== 0);
        this.flag(FLAG_V, (((this.a >> 6) ^ (this.a >> 5)) & 1) !== 0);
        return 0;
      }
      case 68 /* SBX */: {
        const ax = this.a & this.x;
        const m = load();
        this.flag(FLAG_C, ax >= m);
        this.x = this.nz(ax - m);
        return 0;
      }
      case 69 /* ANE */:
        this.a = this.nz((this.a | MAGIC) & this.x & load());
        return 0;
      case 70 /* LXA */:
        this.a = this.x = this.nz((this.a | MAGIC) & load());
        return 0;

      // undocumented: stack-pointer and high-byte stores
      case 71 /* LAS */:
        this.a = this.x = this.s = this.nz(load() & this.s);
        return penalty();
      case 72 /* TAS */: {
        const address = this.operand(op, at);
        this.s = this.a & this.x;
        this.shStore(this.s, address);
        return 0;
      }
      case 73 /* SHA */:
        this.shStore(this.a & this.x, this.operand(op, at));
        return 0;
      case 74 /* SHX */:
        this.shStore(this.x, this.operand(op, at));
        return 0;
      case 75 /* SHY */:
        this.shStore(this.y, this.operand(op, at));
        return 0;

      default:
        throw new Error(`unimplemented ${op.mnemonic}`);
    }
  }
}
