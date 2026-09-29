'use strict';
/**
 * The glob guard: nothing in `test/` may be outside every count, silently.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * `test:focused` is `node --test test/*.test.cjs`. `test/fixtures/quit-sweep-main.cjs`
 * is not matched by that glob — it is a FIXTURE, launched as Electron's main
 * script by `quit-sweep.electron.test.cjs`, not a test in its own right. It
 * cannot be run as a test: under bare node `app` is undefined and it dies at its
 * own line 77 with a TypeError.
 *
 * So the fix is NOT to widen the glob — a fixture run as a test is a false red
 * that trains people to ignore reds. The fix is that a file which can fail and is
 * not in the glob must be KNOWN and NAMED. A blind spot you can see is a
 * different thing from one you cannot: this file makes the escape hatch explicit,
 * and a new fixture outside the glob has to be listed here or this goes red.
 *
 * WHY A GUARD AND NOT A WIDER GLOB, stated once
 *
 * God measured 1018 tests with 14 failures and could only see 13. The 14th was a
 * file no registration-based count could ever reach. The two numbers were not in
 * disagreement — they were the measurement of two different globs, and his was
 * the one that could not see the failure. Every count derived from registration
 * is blind to a file that fails before registering, so the only honest move is to
 * stop trusting a bare glob to be the whole truth and say what sits outside it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.join(__dirname);
const PKG = path.join(TEST_DIR, '..', 'package.json');

/**
 * Every `.cjs` under `test/` that the focused glob does NOT match, with the reason
 * it is allowed to be there. This is the list a human has to keep true; that is
 * the point — it is one short list instead of an unnameable blind spot.
 */
const KNOWN_OUTSIDE_THE_GLOB = {
  'load-ts.cjs':
    'helper: transpiles a .ts module for a test to require. Required by ~80 test files; running it asserts nothing.',
  'home-sandbox.cjs':
    "helper: gives a test a throwaway home on every platform. Sets $HOME AND $USERPROFILE and refuses to run if os.homedir() did not move — $HOME alone is ignored on Windows, so a test using only that believed it was isolated and probed the real ~/.claude instead. Running it asserts nothing.",
  'fixtures\\quit-sweep-main.cjs':
    "fixture: launched as Electron's MAIN script by quit-sweep.electron.test.cjs. Must NOT run as a test: under bare node `app` is undefined and it throws at its own line 77.",
};

function walk(dir, base = TEST_DIR) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(abs, base)); continue; }
    if (e.isFile() && e.name.endsWith('.cjs')) out.push(path.relative(base, abs));
  }
  return out;
}

test('every .cjs under test/ is either in the focused glob or named here', () => {
  // The glob itself, read from package.json rather than restated: a guard that
  // hardcodes the glob it is guarding stops guarding the moment the glob moves.
  const script = require(PKG).scripts['test:focused'];
  assert.ok(script, 'test:focused must exist for this guard to have something to check');
  const m = /test[\/\\]\*\.test\.cjs/.test(script);
  assert.ok(m, `test:focused is no longer the expected glob, so this guard is stale: ${script}`);

  const all = walk(TEST_DIR).map((p) => p.split(path.sep).join('\\')).sort();
  const strays = all.filter((p) => !/^[^\\]+\.test\.cjs$/.test(p));
  for (const p of strays) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(KNOWN_OUTSIDE_THE_GLOB, p),
      `${p} is under test/ but matches no glob and is not named in KNOWN_OUTSIDE_THE_GLOB. `
      + 'Either it is a test and belongs in the glob, or it is a helper/fixture and must be listed here with its reason.'
    );
  }
  // And the other direction: a listed name that no longer exists is a stale
  // exemption. An exemption nobody re-reads is how a blind spot comes back.
  const present = new Set(strays);
  for (const p of Object.keys(KNOWN_OUTSIDE_THE_GLOB)) {
    assert.ok(present.has(p), `KNOWN_OUTSIDE_THE_GLOB lists ${p}, which no longer exists. Remove the entry.`);
  }
});

test('a named fixture really is a fixture: it must not be runnable as a test', () => {
  // The exemption for quit-sweep-main.cjs says "must NOT run as a test". That
  // claim is asserted here, so if someone ever makes it runnable as a test the
  // exemption should be reconsidered rather than left to rot.
  const src = fs.readFileSync(path.join(TEST_DIR, 'fixtures', 'quit-sweep-main.cjs'), 'utf8');
  assert.match(src, /require\(['"]electron['"]\)/, 'the fixture must pull in electron, which is what makes it unrunnable as a test');
  assert.ok(!/require\(['"]node:test['"]\)/.test(src), 'a file that registers node:test cases IS a test and belongs in the glob');
});

test('the electron test that owns the fixture is itself inside the glob', () => {
  // Without this, the exemption above is a hole with no owner: the fixture is
  // outside the glob, and the thing that actually exercises it could also drift
  // out, and then nothing runs it at all.
  const owner = path.join(TEST_DIR, 'quit-sweep.electron.test.cjs');
  assert.ok(fs.existsSync(owner), 'quit-sweep.electron.test.cjs is gone; the fixture exemption has no owner');
  assert.match(fs.readFileSync(owner, 'utf8'), /quit-sweep-main\.cjs/,
    'quit-sweep.electron.test.cjs must reference the fixture, or the fixture is orphaned');
  assert.ok(/^[^\\]+\.test\.cjs$/.test('quit-sweep.electron.test.cjs'), 'the owner itself must be in the glob');
});
