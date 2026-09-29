'use strict';

// Originally contributed by Vyapak Goyal (@gts-47) in #123, extended here with
// the dotted-path cases that the first version's dot-free fixtures could not
// catch.
//
// NOT POSIX-ONLY ANY MORE, and that is the fix rather than a claim.
//
// This file used to redirect `$HOME` only, and `$HOME` is a knob POSIX honours and
// Windows ignores: measured on Windows, `os.homedir()` returned the real home with
// `$HOME` pointed somewhere else, and only moved once `USERPROFILE` was set too.
// So these cases ran here against the real `~/.claude/projects` — `projectDir()`
// probes for the current and legacy key with `existsSync`, so each verdict was a
// function of what the person running the test happened to have in their home.
// The first three cases below still passed, because they only look at
// `path.basename()`; the four that compare whole paths went red.
//
// `withHome` now sets both knobs and throws if the redirect did not take, so a
// platform where it cannot be made to work refuses to run instead of quietly
// testing the wrong directory. See test/home-sandbox.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { withHome: sandboxedHome } = require('./home-sandbox.cjs');

const { projectDir } = loadTs('src/main/transcript.ts');

/** A real temporary home, so `projectDir()` resolves inside it and nowhere else. */
function withHome(run) {
  return sandboxedHome((home) => run(home, (key) => {
    const dir = path.join(home, '.claude/projects', key);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }), { prefix: 'md-transcript-' });
}

test('an unseen cwd resolves to the CURRENT key, leading slash dashed', () => {
  withHome(() => {
    // The regression: this used to return 'Users-me-app', a directory Claude Code
    // has not written to in months, so every read came back empty and every
    // caller read empty as "no data yet".
    assert.equal(path.basename(projectDir('/Users/me/app')), '-Users-me-app');
  });
});

test('DOTS are dashed too, not just slashes', () => {
  withHome(() => {
    // The case a slash-only fix silently fails: Claude Code dashes EVERY
    // non-alphanumeric, so a version-numbered project directory keys as
    // MDv0-3-0. Dashing only the separators yields '-Users-me-MDv0.3.0', which
    // Claude Code never writes to — and because the legacy fallback then finds
    // the harness's own stale twin, the miss looks like a hit.
    assert.equal(
      path.basename(projectDir('/Users/me/Documents/MDv0.3.0')),
      '-Users-me-Documents-MDv0-3-0'
    );
  });
});

test('every other non-alphanumeric is dashed as well', () => {
  withHome(() => {
    assert.equal(
      path.basename(projectDir('/Users/me/my_proj (old)/v1.2')),
      '-Users-me-my-proj--old--v1-2'
    );
  });
});

test('the current directory wins even when a legacy twin exists', () => {
  withHome((_home, mkProject) => {
    // Both spellings exist on a machine that ran the old code: the harness itself
    // created the legacy twin by copying transcripts into it. Preferring the
    // legacy one would mean reading our own stale copies forever.
    const legacy = mkProject('Users-me-app');
    const current = mkProject('-Users-me-app');
    const resolved = projectDir('/Users/me/app');
    assert.equal(resolved, current);
    assert.notEqual(resolved, legacy);
  });
});

test('the dotted legacy twin loses to the dotted current spelling', () => {
  withHome((_home, mkProject) => {
    const legacy = mkProject('Users-me-MDv0.3.0');
    const current = mkProject('-Users-me-MDv0-3-0');
    const resolved = projectDir('/Users/me/MDv0.3.0');
    assert.equal(resolved, current);
    assert.notEqual(resolved, legacy);
  });
});

/**
 * The two legacy-fallback cases below describe a MIGRATION, and the migration only
 * ever happened on POSIX.
 *
 * `legacyProjectKey()` returns `projectKey()` unchanged on win32
 * (src/main/transcript.ts:20-24): Windows always used the one rule, so a Windows
 * install never wrote the old dotted-and-slash spelling and has nothing to
 * migrate from. A fixture that creates `Users-me-app` and expects the fallback to
 * find it is therefore describing a POSIX-only history — and on Windows the
 * expectation is unsatisfiable by construction, not broken.
 *
 * So they skip here, loudly, rather than being asserted and failed. That is the
 * honest form of "this does not run on this platform": a green test that quietly
 * stops checking something is worse than a red one that says why, and a red one
 * that says why is one somebody can close.
 */
const legacyMigrationHappened = process.platform !== 'win32';
const LEGACY_SKIP = 'the pre-2026 POSIX key never existed on Windows: legacyProjectKey() returns the current key there, so there is no legacy spelling to fall back to';

test('a legacy-only install still resolves, so old transcripts stay readable', { skip: legacyMigrationHappened ? false : LEGACY_SKIP }, () => {
  withHome((_home, mkProject) => {
    const legacy = mkProject('Users-me-app');
    assert.equal(projectDir('/Users/me/app'), legacy);
  });
});

test('a legacy-only install with dots resolves to its undashed twin', { skip: legacyMigrationHappened ? false : LEGACY_SKIP }, () => {
  withHome((_home, mkProject) => {
    // The legacy key kept dots, so the fallback has to keep them too — deriving
    // it from the new key by stripping the leading dash would look for
    // 'Users-me-MDv0-3-0' and find nothing.
    const legacy = mkProject('Users-me-MDv0.3.0');
    assert.equal(projectDir('/Users/me/MDv0.3.0'), legacy);
  });
});

test('the real failing path resolves to the dir Claude Code actually writes', () => {
  withHome((_home, mkProject) => {
    // The exact cwd whose transcripts the condense step could not find (#123).
    const cwd = '/Users/vyapakgoyal/Documents/HarnessAgents';
    mkProject('-Users-vyapakgoyal-Documents-HarnessAgents');
    mkProject('Users-vyapakgoyal-Documents-HarnessAgents');
    assert.equal(
      path.basename(projectDir(cwd)),
      '-Users-vyapakgoyal-Documents-HarnessAgents'
    );
  });
});

test('a root cwd never resolves to the projects directory itself', () => {
  withHome((home, _mkProject) => {
    // legacyProjectKey('/') is the empty string, and path.join(root, '') is the
    // projects ROOT — which always exists, so an unguarded fallback would hand
    // back the directory holding EVERY project and seed the session file there.
    const resolved = projectDir('/');
    assert.notEqual(resolved, path.join(home, '.claude/projects'));
    assert.equal(path.basename(resolved), '-');
  });
});
