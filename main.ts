// Driver for markdown-render-speed-02.
// The harness runs `node /bot/main.ts` (node 22). It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one
// alone with parse() from parse.js, and writes /output/html.json: a JSON
// array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// The entry is run twice into the same /output directory, and the two
// runs may overlap. The output is therefore written to a per-run
// temporary file (keyed by pid + a random token, so two runs in separate
// containers where node is pid 1 can never collide) and then moved into
// place with a single atomic rename; the file is never written
// in place, so a concurrent reader never sees a half-written html.json.
// Both runs produce byte-identical content, so whichever rename lands
// last leaves the same file behind.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(OUTPUT_DIR, { recursive: true });

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html = [];
for (const c of cases) html.push(parse(c.markdown));

const tmpName = '.html.json.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
const tmpPath = join(OUTPUT_DIR, tmpName);
writeFileSync(tmpPath, JSON.stringify(html));
renameSync(tmpPath, join(OUTPUT_DIR, 'html.json'));
