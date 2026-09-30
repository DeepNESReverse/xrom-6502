// Vendors a sample of Tom Harte's SingleStepTests for the NES's 6502
// (github.com/SingleStepTests/65x02, nes6502/v1, MIT) into test/harte/.
//
// Each opcode's file holds 10 000 cases and is ~5 MB; only the first few
// dozen are needed, so this asks for the start of each file with a Range
// request and cuts the JSON array at the last complete case.
import { writeFile } from 'node:fs/promises';

const PER_OPCODE = 30;
const base = 'https://raw.githubusercontent.com/SingleStepTests/65x02/main/nes6502/v1/';

async function fetchHead(name, bytes) {
  const response = await fetch(base + name, { headers: { Range: `bytes=0-${bytes - 1}` } });
  if (!response.ok && response.status !== 206) throw new Error(`${name}: HTTP ${response.status}`);
  return response.text();
}

for (let op = 0; op < 256; op++) {
  const name = op.toString(16).padStart(2, '0') + '.json';
  let text = await fetchHead(name, 60000);
  // Cut after the last complete top-level object: "}, {" separates cases.
  let cases;
  for (let size = 60000; ; size *= 2) {
    const cut = text.lastIndexOf('},\n{') >= 0 ? text.lastIndexOf('},\n{') : text.lastIndexOf('}, {');
    try {
      cases = JSON.parse(text.slice(0, cut + 1) + ']');
      if (cases.length >= PER_OPCODE) break;
    } catch {}
    text = await fetchHead(name, size * 2);
  }
  await writeFile(`test/harte/${name}`, JSON.stringify(cases.slice(0, PER_OPCODE)));
  process.stdout.write(op % 32 === 31 ? `${name}\n` : '.');
}
