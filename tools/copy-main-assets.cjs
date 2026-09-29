'use strict';

const { copyFileSync, mkdirSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');
// The list lives in its own module because `electron.vite.config.ts` needs the
// SAME one for `npm run dev`, which never runs this script. Two copies of this
// array is how `tts-budget.cjs` came to be missing from dev — see main-sidecars.
const { MAIN_ASSETS } = require('./main-sidecars.cjs');

const ROOT = join(__dirname, '..');

for (const [fromRel, toRel] of MAIN_ASSETS) {
  const from = join(ROOT, fromRel);
  const to = join(ROOT, toRel);

  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);

  const copied = statSync(to);
  if (!copied.isFile() || copied.size === 0) {
    throw new Error(`Failed to copy required main-process asset: ${fromRel} -> ${toRel}`);
  }
  console.log(`[copy-main-assets] ${fromRel} -> ${toRel}`);
}
