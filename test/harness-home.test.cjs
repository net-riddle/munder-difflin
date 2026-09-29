'use strict';

/**
 * Issue #140 — the onboarding harness-home field is typed by hand as often as it
 * is picked, and `~/HarnessAgents` is the suggestion itself. Node's fs treats a
 * literal `~` as a directory name, so ensureHarnessHome died with ENOENT and the
 * un-expanded home would have been persisted, poisoning every path derived from
 * it.
 *
 * This file exercises the REAL ensureHarnessHome / writeConfig / readConfig from
 * src/main/config.ts (electron's app.getPath stubbed to a temp dir). It replaces
 * the stand-in test that used to live in expand-tilde.test.cjs — that one only
 * re-ran expandTilde and would still have passed with the expandTilde call
 * deleted from the real ensureHarnessHome.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { withHome } = require('./home-sandbox.cjs');

// config.ts pulls app.getPath('userData') from electron; outside Electron that
// resolve gives a path string, so seed the cache with a temp userData dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { ensureHarnessHome, writeConfig, readConfig } = loadTs('src/main/config.ts');

test.after(() => { fs.rmSync(userData, { recursive: true, force: true }); });

/*
 * Both tests below used to create a real directory inside the developer's home
 * and rely on `t.after`/`finally` to remove it — which is exactly the residue a
 * killed process leaves behind, in the one place nobody goes looking. They run
 * against a temporary home now.
 *
 * The assertion that mattered does not change. It was never "this lands in MY
 * home": it was "this lands in A home, and not in a directory literally named
 * `~`". `expandTilde` is home-agnostic, so a temporary home tests the same
 * thing — and the only wording that had to change is the word "REAL", which
 * would have become false.
 */

test('ensureHarnessHome creates a tilde path on disk (issue #140)', () => withHome((home) => {
  const name = `md-harness-home-${process.pid}`;
  const res = ensureHarnessHome(`~/${name}`);
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.existsSync(path.join(home, name)), true, 'inside a home, not a literal "~" folder');
}));

test('writeConfig persists harnessHome EXPANDED, like registeredRepos', () => withHome((home) => {
  const name = `md-harness-home-${process.pid}-cfg`;
  const expanded = path.join(home, name);
  const cfg = writeConfig({ harnessHome: `~/${name}` });
  assert.equal(cfg.harnessHome, expanded);
  assert.equal(cfg.recentHives[0], expanded, 'recent-hives tracking stores the same absolute path');
  assert.equal(readConfig().harnessHome, expanded, 'what lands on disk is absolute');
}));
