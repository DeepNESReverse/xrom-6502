import { describe, expect, it } from 'vitest';
import { Cpu6502, FLAG_B, FLAG_I, decode, disassemble } from '../src/index.js';

/** A 64 KB flat memory with `program` at `origin` and the vectors pointed at it. */
function machine(program: number[], origin = 0xc000) {
  const memory = new Uint8Array(0x10000);
  memory.set(program, origin);
  memory[0xfffc] = origin & 0xff;
  memory[0xfffd] = origin >> 8;
  const cpu = new Cpu6502({ read: (a) => memory[a], write: (a, v) => void (memory[a] = v) });
  return { cpu, memory };
}

describe('the CPU around its instructions', () => {
  it('starts at the reset vector', () => {
    const { cpu } = machine([0xea]);
    cpu.reset();
    expect(cpu.pc).toBe(0xc000);
    expect(cpu.p & FLAG_I).toBeTruthy();
  });

  it('runs a loop and counts its cycles', () => {
    // LDX #5; loop: DEX; BNE loop; BRK — 2 + 5×(2+3) − 1 cycles before BRK.
    const { cpu } = machine([0xa2, 0x05, 0xca, 0xd0, 0xfd, 0x00]);
    cpu.reset();
    const start = cpu.cycles;
    while (cpu.pc !== 0xc005) cpu.step();
    expect(cpu.x).toBe(0);
    expect(cpu.cycles - start).toBe(2 + 5 * 2 + 4 * 3 + 2);
  });

  it('takes an NMI through $FFFA and returns with RTI', () => {
    const { cpu, memory } = machine([0xea, 0xea]);
    memory.set([0xe8, 0x40], 0xd000); // handler: INX; RTI
    memory[0xfffa] = 0x00;
    memory[0xfffb] = 0xd0;
    cpu.reset();
    cpu.step();
    cpu.nmi();
    expect(cpu.pc).toBe(0xd000);
    cpu.step();
    cpu.step();
    expect(cpu.x).toBe(1);
    expect(cpu.pc).toBe(0xc001);
  });

  it('ignores IRQ while I is set, and takes it once cleared', () => {
    const { cpu, memory } = machine([0xea, 0x58, 0xea]); // NOP; CLI; NOP
    memory[0xfffe] = 0x00;
    memory[0xffff] = 0xd0;
    cpu.reset();
    cpu.irq();
    expect(cpu.pc).toBe(0xc000);
    cpu.step();
    cpu.step();
    cpu.irq();
    expect(cpu.pc).toBe(0xd000);
  });

  it('pushes B for BRK but not for an interrupt', () => {
    const { cpu, memory } = machine([0x00, 0xea]);
    memory[0xfffe] = 0x00;
    memory[0xffff] = 0xd0;
    cpu.reset();
    cpu.step();
    expect(memory[0x100 | ((cpu.s + 1) & 0xff)] & FLAG_B).toBeTruthy();
    // Return address skips the padding byte after BRK.
    expect(memory[0x100 | ((cpu.s + 2) & 0xff)]).toBe(0x02);
  });

  it('stops on JAM and stays stopped', () => {
    const { cpu } = machine([0x02, 0xea]);
    cpu.reset();
    cpu.step();
    cpu.run(100);
    expect(cpu.jammed).toBe(true);
    expect(cpu.pc).toBe(0xc000);
  });
});

describe('disassembly', () => {
  it('writes every addressing mode the way assemblers do', () => {
    const bytes = [0xa9, 0x10, 0xb1, 0x12, 0x9d, 0x00, 0x02, 0x6c, 0xfc, 0xff, 0xd0, 0xfe, 0x0a, 0xa7, 0x40];
    expect(disassemble(Uint8Array.from(bytes), 0xc000)).toEqual([
      '$C000  A9 10     LDA #$10',
      '$C002  B1 12     LDA ($12),Y',
      '$C004  9D 00 02  STA $0200,X',
      '$C007  6C FC FF  JMP ($FFFC)',
      '$C00A  D0 FE     BNE $C00A',
      '$C00C  0A        ASL A',
      '$C00D  A7 40     LAX $40   ; undocumented',
    ]);
  });

  it('knows where branches and jumps go', () => {
    const code = [0x20, 0x34, 0x12];
    expect(decode((a) => code[a - 0x8000] ?? 0, 0x8000).target).toBe(0x1234);
  });
});
