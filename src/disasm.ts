/**
 * Bytes back into assembly — one instruction at a time, or a run of them.
 *
 * Undocumented opcodes decode too, flagged, so a caller reading data by mistake
 * can tell: a run of JAMs and SHAs in the middle of "code" is usually a table.
 */

import { OPCODES, type Opcode } from './opcodes.js';

export interface Instruction {
  address: number;
  opcode: Opcode;
  /** The instruction's bytes, opcode first. */
  bytes: number[];
  /** The operand as assembly writes it: `#$10`, `$0200,X`, `($12),Y`… */
  operand: string;
  /** Mnemonic and operand: `LDA ($12),Y`. */
  text: string;
  /** Where a branch, JMP or JSR goes, when that is known without running it. */
  target?: number;
}

const hex = (value: number, digits: number) => value.toString(16).toUpperCase().padStart(digits, '0');

/** Decode the instruction at `address`, reading bytes with `read`. */
export function decode(read: (address: number) => number, address: number): Instruction {
  const opcode = OPCODES[read(address) & 0xff];
  const bytes = Array.from({ length: opcode.length }, (_, i) => read((address + i) & 0xffff) & 0xff);
  const b1 = bytes[1] ?? 0;
  const word = b1 | ((bytes[2] ?? 0) << 8);
  let operand = '';
  let target: number | undefined;
  switch (opcode.mode) {
    case 'acc':
      operand = 'A';
      break;
    case 'imm':
      operand = `#$${hex(b1, 2)}`;
      break;
    case 'zp':
      operand = `$${hex(b1, 2)}`;
      break;
    case 'zpx':
      operand = `$${hex(b1, 2)},X`;
      break;
    case 'zpy':
      operand = `$${hex(b1, 2)},Y`;
      break;
    case 'izx':
      operand = `($${hex(b1, 2)},X)`;
      break;
    case 'izy':
      operand = `($${hex(b1, 2)}),Y`;
      break;
    case 'abs':
      operand = `$${hex(word, 4)}`;
      if (opcode.mnemonic === 'JMP' || opcode.mnemonic === 'JSR') target = word;
      break;
    case 'abx':
      operand = `$${hex(word, 4)},X`;
      break;
    case 'aby':
      operand = `$${hex(word, 4)},Y`;
      break;
    case 'ind':
      operand = `($${hex(word, 4)})`;
      break;
    case 'rel':
      target = (address + 2 + (b1 < 0x80 ? b1 : b1 - 0x100)) & 0xffff;
      operand = `$${hex(target, 4)}`;
      break;
  }
  const text = operand ? `${opcode.mnemonic} ${operand}` : opcode.mnemonic;
  return { address, opcode, bytes, operand, text, target };
}

/**
 * Disassemble `bytes` as code loaded at `origin`, as listing lines:
 * `$C000  A9 10     LDA #$10`.
 */
export function disassemble(bytes: Uint8Array, origin = 0): string[] {
  const lines: string[] = [];
  const read = (address: number) => bytes[(address - origin) & 0xffff] ?? 0;
  for (let offset = 0; offset < bytes.length; ) {
    const at = (origin + offset) & 0xffff;
    const ins = decode(read, at);
    const raw = ins.bytes.map((b) => hex(b, 2)).join(' ');
    lines.push(`$${hex(at, 4)}  ${raw.padEnd(9)} ${ins.text}${ins.opcode.official ? '' : '   ; undocumented'}`);
    offset += ins.opcode.length;
  }
  return lines;
}
