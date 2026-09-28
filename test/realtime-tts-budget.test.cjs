const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SRC = path.join(__dirname, '..', 'src', 'main', 'realtime.ts');

// The main-process TTS transport, tested for the first time.
//
// Why this file exists: every announcement timeout in `realtime.log` came out of
// `speak()` in this module, and NO test file loaded it. The suite measured the
// renderer's playback, the announcer, the phrase table and the checker — 46
// cases in all — and the function that actually failed was not one of them.
// A green suite over the neighbours is not coverage of the thing that broke.

// The budget itself is loaded from the shared plain-JS module, which is the whole
// point: the voice-outbox script loads this same file, so the two speaking
// routes cannot drift into different ceilings. The main module is still read for
// the structural pins, because "realtime.ts no longer defines the policy" is
// exactly the regression worth failing on.
// Loaded lazily and tolerantly ON PURPOSE: if the shared module is missing, the
// numeric cases below fail on the right thing (there is no policy to test) while
// the structural cases still run and say the sharper thing — that the main module
// is where the policy used to live. A top-level require would take the whole file
// down and the structural pin with it, which is a test that cannot report a
// regression.
const budget = (() => {
  try { return require(path.join(__dirname, '..', 'src', 'main', 'tts-budget.cjs')); }
  catch { return null; }
})();
const realtimeSrc = () => fs.readFileSync(SRC, 'utf8');

test('the shared module exists: one policy, loadable by a plain .mjs', () => {
  assert.ok(budget, 'src/main/tts-budget.cjs must exist and export speakBudgetMs');
  assert.equal(typeof budget.speakBudgetMs, 'function');
  assert.equal(typeof budget.MAX_SPEAK_CHARS, 'number', 'the cap travels with the policy, not beside it');
});

test('the synthesis budget is a function of the text, not a flat number', () => {
  if (!budget) return; // the case above is the failure
  // The old flat threshold was 20 s. Every one of these is above it, and every
  // one of them was measured on the same server doing exactly what it was asked.
  const brief = budget.speakBudgetMs(30);
  const measured = budget.speakBudgetMs(464);
  assert.ok(brief >= 60_000, `a one-line briefing needs more than 20 s, got ${brief}`);
  assert.ok(measured > brief, 'a longer text must get a longer budget');
  assert.ok(measured >= 197_700, `464 chars took 197.7 s end to end, so the budget must cover it, got ${measured}`);
});

test('the budget is bounded on both sides', () => {
  if (!budget) return;
  // Unbounded is not a fix, it is a hang: past the ceiling, waiting longer hides
  // the fault instead of surfacing it.
  assert.equal(budget.speakBudgetMs(0), 60_000, 'no text still gets the floor');
  assert.equal(budget.speakBudgetMs(2000), 600_000, 'a full-length message hits the ceiling');
  assert.ok(budget.speakBudgetMs(10 ** 9) <= 600_000, 'absurd input must not buy an absurd wait');
  assert.ok(budget.speakBudgetMs(-5) >= 60_000, 'negative input must not buy a shorter wait than the floor');
  assert.ok(budget.speakBudgetMs(NaN) >= 60_000, 'NaN must not become 0 and skip the floor');
});

test('one definition, two routes: the policy is not duplicated in the main module', () => {
  // The defect this card closes: the app had a timeout and the script had none,
  // and nobody noticed because the two numbers were in two files. A second
  // definition anywhere is the same defect wearing a new name, so it is pinned.
  const src = realtimeSrc();
  assert.doesNotMatch(src, /export function speakBudgetMs/, 'realtime.ts must not define the policy');
  assert.doesNotMatch(src, /SPEAK_BUDGET_(?:FLOOR|PER_CHAR|CEILING)_MS\s*=/, 'the numbers must not live here either');
  assert.match(src, /require\('\.\/tts-budget\.cjs'\)/, 'and it must load the shared module');

  // and the shipped copy: without this entry the packaged build silently loses it
  const copy = fs.readFileSync(path.join(__dirname, '..', 'tools', 'copy-main-assets.cjs'), 'utf8');
  assert.match(copy, /src\/main\/tts-budget\.cjs/, 'copy-main-assets must ship it, or the packaged app has no budget');
});

test('a timeout says how long it waited, what it was allowed, and for how much text', () => {
  // The reason this is a test and not a comment: the old error was the bare
  // string 'TTS request timed out', written when the request gave up. With no
  // start time in the log, "needed 19.9 s" and "needed 40 s" were the same line.
  const src = realtimeSrc();
  assert.match(src, /TTS request timed out after \$\{Date\.now\(\) - started\}ms/,
    'the abort error must carry the elapsed time');
  assert.match(src, /budget \$\{budget\}ms for \$\{input\.length\} chars/,
    'and the budget and the size it was for');
  assert.ok(!/const SPEAK_TIMEOUT_MS = /.test(src), 'the flat threshold must be gone, not kept beside the new one');
});

test('the evidence does not support "start fails, done plays"', () => {
  // The card said "start times out 3 of 3, done plays 3 of 3". These are the
  // lines it was built on, plus the four that came later in the same file — and
  // they show both kinds of announcement doing both things. The fixture is a
  // literal, not the user's live `realtime.log`: a test whose fixture is a file
  // that rotates and gets truncated would rot with it, and would stop meaning
  // anything while still looking green.
  const lines = `
2026-09-28T21:25:45.644Z ERROR at tts: TTS request timed out
2026-09-28T21:25:45.646Z announce-incomplete task-pam-019 start -> failed
2026-09-28T21:28:47.340Z announce task-pam-019 done -> played
2026-09-28T21:32:00.261Z announce task-god-001 done -> played
2026-09-28T21:42:27.572Z ERROR at tts: TTS request timed out
2026-09-28T21:42:27.574Z announce-incomplete task-jim-061 start -> failed
2026-09-28T21:58:07.501Z announce-incomplete task-pam-021 done -> failed
2026-09-28T21:58:07.502Z announce-incomplete task-jim-061 done -> failed
2026-09-28T21:58:40.921Z announce task-jim-064 start -> played
2026-09-28T21:58:40.922Z announce task-pam-022 start -> played
2026-09-28T22:06:29.093Z announce-incomplete task-jim-064 done -> failed
2026-09-28T22:10:59.486Z announce-incomplete task-pam-022 done -> failed
2026-09-28T22:23:19.355Z announce task-jim-020 done -> played
`.trim().split('\n');

  const played = (k) => lines.filter((l) => l.includes(` ${k} -> played`)).length;
  const failed = (k) => lines.filter((l) => l.includes(`announce-incomplete`) && l.includes(` ${k} -> failed`)).length;

  assert.ok(played('start') > 0, 'a start announcement has played');
  assert.ok(played('done') > 0, 'a done announcement has played');
  assert.ok(failed('start') > 0, 'a start announcement has failed');
  assert.ok(failed('done') > 0, 'a done announcement has failed');
  // So neither branch is the discriminator, and any fix aimed at the `start`
  // branch would be aimed at nothing.
  assert.notEqual(played('start'), 0);
  assert.ok(played('start') * failed('done') > 0, 'the two outcomes cross branches');
});

