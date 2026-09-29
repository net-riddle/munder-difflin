const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAIN_ASSETS } = require('../tools/main-sidecars.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The app died at launch, twice, from the same shape of mistake.
//
// `require('./tts-budget.cjs')` in realtime.ts resolves at RUNTIME, against
// out/main/. rollup neither bundles nor copies a require()'d .cjs, so the file
// has to be emitted by hand — and the two places that did it had drifted. The
// build script listed the file; the vite hook did not. Since `npm run dev` is
// plain `electron-vite dev` and never runs the build script, the app crashed on
// launch in dev and only in dev, which is why it was reported as flaky and
// "came back" instead of as a missing file.
//
// These tests exist so the third occurrence is a failing test rather than a
// startup crash the user has to photograph.

// Every .cjs the main process requires must be in the ONE shared manifest.
// Derived by scanning src/main rather than from a list, so a new sidecar that
// nobody remembered to register is a failure here instead of a crash at boot.
test('every runtime .cjs in src/main is registered in the shared manifest', () => {
  const onDisk = fs
    .readdirSync(path.join(ROOT, 'src', 'main'))
    .filter((f) => f.endsWith('.cjs'))
    .sort();
  const registered = MAIN_ASSETS.map(([from]) => path.basename(from)).sort();
  assert.deepEqual(registered, onDisk);
});

// The manifest and the build script must not be able to disagree again.
test('the build script reads the shared manifest instead of its own copy', () => {
  const src = read('tools/copy-main-assets.cjs');
  assert.match(
    src,
    /require\('\.\/main-sidecars\.cjs'\)/,
    'copy-main-assets.cjs must import the manifest, not declare a second list'
  );
  // A literal entry pair in the script means the list was forked again.
  const literal = src.match(/\[\s*'src\/main\/[a-z-]+\.cjs'\s*,/);
  assert.equal(literal, null, 'copy-main-assets.cjs declares a sidecar inline; use the manifest');
});

// And the same for the vite hook, which is the one that actually runs in dev.
test('the vite writeBundle hook reads the shared manifest', () => {
  const src = read('electron.vite.config.ts');
  assert.match(
    src,
    /main-sidecars\.cjs/,
    'electron.vite.config.ts must import the manifest, not declare a second list'
  );
  const literal = src.match(/\[\s*'src\/main\/[a-z-]+\.cjs'\s*,/);
  assert.equal(literal, null, 'electron.vite.config.ts declares a sidecar inline; use the manifest');
});

// The regression itself, stated as the fact that failed: the file the voice
// bridge requires at boot was missing from out/main.
test('tts-budget.cjs is registered, and it is the one realtime.ts requires', () => {
  assert.ok(
    MAIN_ASSETS.some(([from, to]) => from === 'src/main/tts-budget.cjs' && to === 'out/main/tts-budget.cjs'),
    'tts-budget.cjs must be copied to out/main or the app dies at launch'
  );
  const realtime = read('src/main/realtime.ts');
  assert.match(realtime, /require\('\.\/tts-budget\.cjs'\)/);
});

// A manifest entry pointing at a file that does not exist would fail the build
// with a confusing copy error rather than a clear one here.
test('every manifest entry points at a file that exists and is non-empty', () => {
  for (const [from, to] of MAIN_ASSETS) {
    const abs = path.join(ROOT, from);
    assert.ok(fs.existsSync(abs), `${from} is registered but does not exist`);
    assert.ok(fs.statSync(abs).size > 0, `${from} is empty`);
    assert.match(to, /^out\/main\//, `${to} must land next to the main bundle`);
  }
});

// `npm run dev` is `electron-vite dev` with no copy step, so the hook is the only
// thing that can save dev from this. If the hook is ever dropped, dev breaks
// again with no build-time signal — so assert the wiring, not just the manifest.
test('the copy hook is still wired into the main build', () => {
  const src = read('electron.vite.config.ts');
  assert.match(src, /copyMainSidecars\(\)/, 'the writeBundle hook must still be called by the main config');
});
