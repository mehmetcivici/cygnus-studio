// Regenerates packages/protocol/test/vectors/cycan-vectors.json (golden vectors shared with
// the C firmware tests). Run from the repo root: npx tsx tools/gen-vectors.ts
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVectors } from '../packages/protocol/test/vectors/cases';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'packages/protocol/test/vectors/cycan-vectors.json');
writeFileSync(out, `${JSON.stringify(buildVectors(), null, 2)}\n`);
console.log(`wrote ${out}`);
