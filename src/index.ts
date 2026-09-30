/**
 * @xromdev/6502 — the NES's CPU in TypeScript.
 *
 * `Cpu6502` runs code against a `Bus` you supply, one instruction at a time,
 * counting cycles. `OPCODES` describes all 256 opcodes; `disassemble` turns
 * bytes back into assembly.
 */

export { Cpu6502, FLAG_B, FLAG_C, FLAG_D, FLAG_I, FLAG_N, FLAG_U, FLAG_V, type Bus } from './cpu.js';
export { MODE_LENGTH, OPCODES, type AddrMode, type Opcode } from './opcodes.js';
export { decode, disassemble, type Instruction } from './disasm.js';
