# @xromdev/cpu6502

The NES's CPU — the 6502 in the 2A03 — in TypeScript. **All 256 opcodes, cycle
counts, a bus you plug memory into.**

- Every opcode, the undocumented ones too (LAX, SAX, DCP, ISC, SLO, RLA, SRE,
  RRA, ANC, ALR, ARR, SBX, the SH\* family…) — NES games and music drivers use them.
- Cycle-counted: page-crossing and branch penalties included, so a caller knows
  *when* inside a frame each write happened.
- NMI, IRQ, BRK, reset, and JAM (the chip stops, as the real one does).
- No decimal mode — the 2A03 has the D flag but no BCD arithmetic.
- **Checked against [Tom Harte's SingleStepTests](https://github.com/SingleStepTests/65x02)**
  for the NES 6502: final registers, memory and cycle count, every opcode.
- ~4 KB gzipped, no dependencies, ~48 million instructions a second (about
  67× a real NES) on a laptop.

It runs the music drivers behind [@xromdev/nsf](https://github.com/DeepNESReverse/xrom-nsf),
and the sound on [xrom.dev](https://xrom.dev).

## Install

```sh
npm install @xromdev/cpu6502
```

## Use

```ts
import { Cpu6502, disassemble } from '@xromdev/cpu6502';

const memory = new Uint8Array(0x10000);
memory.set([0xa2, 0x05, 0xca, 0xd0, 0xfd, 0x00], 0xc000); // LDX #5; DEX; BNE; BRK
memory[0xfffc] = 0x00;
memory[0xfffd] = 0xc0; // reset vector → $C000

const cpu = new Cpu6502({
  read: (address) => memory[address],
  write: (address, value) => { memory[address] = value; },
});
cpu.reset();
while (cpu.pc !== 0xc005) cpu.step(); // step() returns the cycles it took
console.log(cpu.x, cpu.cycles);

console.log(disassemble(memory.subarray(0xc000, 0xc006), 0xc000));
// [ '$C000  A2 05     LDX #$05', '$C002  CA        DEX', '$C003  D0 FD     BNE $C002', '$C005  00        BRK' ]
```

The bus is yours: memory-mapped hardware is just a `read` or `write` that does
something — that is how `@xromdev/nsf` catches the driver's writes to the APU.

## API

| | |
|---|---|
| `new Cpu6502(bus)` | `a x y s p pc` registers, `cycles` run so far, `jammed`. |
| `cpu.step()` | Run one instruction; returns its cycles. |
| `cpu.run(cycles)` | Run until at least that many cycles have passed. |
| `cpu.reset()`, `cpu.nmi()`, `cpu.irq()` | Through `$FFFC`, `$FFFA`, `$FFFE`; IRQ respects the I flag. |
| `OPCODES[byte]` | `{ mnemonic, mode, length, cycles, pagePenalty, official }` for all 256. |
| `decode(read, address)` | One instruction: bytes, `LDA ($12),Y` text, branch/jump target. |
| `disassemble(bytes, origin)` | A listing, undocumented opcodes marked. |

## Not modelled

- Bus-cycle-exact dummy reads and writes (the extra read on a page cross, the
  double write of a read-modify-write). Final state and cycle counts are exact;
  the individual bus accesses inside an instruction are not reproduced.
- The unstable undocumented opcodes (ANE, LXA, SHA, SHX, SHY, TAS) follow the
  behaviour SingleStepTests record; real chips differ between each other.

## Development

```sh
npm install
npm test               # vitest: SingleStepTests sample + behaviour tests
node scripts/fetch-harte.mjs   # re-vendor the SingleStepTests sample
```

The SingleStepTests sample in `test/harte` is from
[SingleStepTests/65x02](https://github.com/SingleStepTests/65x02) (MIT, © Thomas Harte).

## License

MIT © Oleksandr Maksymov
