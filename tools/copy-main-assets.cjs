'use strict';

const { copyFileSync, mkdirSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

const ROOT = join(__dirname, '..');
const MAIN_ASSETS = [
  ['src/main/slack-trigger.cjs', 'out/main/slack-trigger.cjs'],
  // Knowledge Graph core (pure-JS, no native deps) — required by knowledge.ts.
  ['src/main/kg-core.cjs', 'out/main/kg-core.cjs'],
  // The synthesis budget, shared with the voice-outbox script: a plain-JS module
  // because node cannot import TypeScript, so the two speaking routes cannot
  // drift into different ceilings. Required by realtime.ts.
  ['src/main/tts-budget.cjs', 'out/main/tts-budget.cjs'],
];

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
