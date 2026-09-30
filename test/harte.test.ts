import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cpu6502, OPCODES } from '../src/index.js';

/**
 * Tom Harte's SingleStepTests for the NES's 6502 (SingleStepTests/65x02,
 * nes6502/v1, MIT): for each opcode, a machine state before one instruction,
 * the state after, and the bus cycles in between. A sample of 30 cases per
 * opcode is vendored in test/harte (scripts/fetch-harte.mjs).
 *
 * Checked: every register, every byte of memory the case lists, and the cycle
 * count. JAM is left out — it halts the chip, and there is no "after".
 */

interface State {
  pc: number;
  s: number;
  a: number;
  x: number;
  y: number;
  p: number;
  ram: [number, number][];
}
interface Case {
  name: string;
  initial: State;
  final: State;
  cycles: unknown[];
}

const dir = path.join(import.meta.dirname, 'harte');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

function run(test: Case) {
  const memory = new Map<number, number>();
  for (const [address, value] of test.initial.ram) memory.set(address, value);
  const cpu = new Cpu6502({
    read: (address) => memory.get(address) ?? 0,
    write: (address, value) => void memory.set(address, value),
  });
  Object.assign(cpu, {
    pc: test.initial.pc,
    s: test.initial.s,
    a: test.initial.a,
    x: test.initial.x,
    y: test.initial.y,
    p: test.initial.p,
  });
  const cycles = cpu.step();
  const got = {
    pc: cpu.pc,
    s: cpu.s,
    a: cpu.a,
    x: cpu.x,
    y: cpu.y,
    p: cpu.p,
    ram: test.final.ram.map(([address]) => [address, memory.get(address) ?? 0]),
    cycles,
  };
  const want = { ...test.final, cycles: test.cycles.length };
  return { got, want };
}

describe('SingleStepTests, nes6502', () => {
  for (const file of files) {
    const code = parseInt(file, 16);
    const op = OPCODES[code];
    if (op.mnemonic === 'JAM') continue;
    it(`$${file.slice(0, 2).toUpperCase()} ${op.mnemonic} ${op.mode}${op.official ? '' : ' (undocumented)'}`, () => {
      const cases = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Case[];
      for (const test of cases) {
        const { got, want } = run(test);
        expect(got, test.name).toEqual({
          pc: want.pc,
          s: want.s,
          a: want.a,
          x: want.x,
          y: want.y,
          p: want.p,
          ram: want.ram,
          cycles: want.cycles,
        });
      }
    });
  }
});
