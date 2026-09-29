'use strict';

// task-jim-081: `condense` was paying a real `claude -p` Haiku run — minutes, a
// process, tokens — once per agent per tick, purely to be told that its answer
// could not be read back. The precondition (`~/.claude/projects/<key>/` for the
// cwd it is about to use) is one `existsSync` away, and it is NOT transient.
//
// Measured on the floor before the change: 101 `condense-abort`, 0
// `kind:'condense'`, growing ~3 per 10 minutes, and 1.103.841 B of memory.md
// that this service exists to reclaim and never has.
//
// The tests below pin the two halves that matter:
//
//   1. NO PROCESS. `summarize-failed` is logged from exactly one place — the
//      catch around `summarize`. So "the result is `precondition-missing` and no
//      `summarize-failed` was logged" is a PROOF that the expensive branch was
//      never entered, not an inference from a duration.
//   2. NO VACUITY. `transcriptPrecheck` is also asserted in the passing
//      direction, so a guard that always returned `not ok` would fail here. The
//      passing branch of `reflectNow` is deliberately NOT exercised end-to-end:
//      it would spawn the very process this card exists to avoid.
//
// The standing condition is logged once and only when it changes, because a line
// per tick is not a record, it is noise that hides the moment it starts or stops.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { transcriptPrecheck, extractLastAssistantText } = loadTs('src/main/hiddenClaude.ts');
const { MemoryReflector } = loadTs('src/main/reflect.ts');

const AGENT = 'tester';

/** Redirects os.homedir() to a throwaway directory so the real ~/.claude is
 *  never read or written. Windows os.homedir() reads USERPROFILE, so both are
 *  set and the file runs on either platform. */
function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reflect-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run(home);
  } finally {
    for (const k of ['HOME', 'USERPROFILE']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A memory.md over the byte trigger with enough `## ` sections that there is
 *  something to evict — `nothing-to-evict` returns BEFORE the precondition, and
 *  a test that exits early proves nothing. */
function bigMemory() {
  const body = 'x'.repeat(1200);
  return ['# Memory — tester', '', ...Array.from({ length: 6 },
    (_, i) => `## Section ${i + 1}\n\n${body}\n`)].join('\n');
}

/** A reflector over a throwaway hive, collecting every log line. */
function makeReflector(home, log) {
  const agents = path.join(home, 'hive', 'agents', AGENT);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'memory.md'), bigMemory(), 'utf8');
  return new MemoryReflector(
    () => home,
    () => 'claude',
    () => ({}),
    () => ({
      // byteTriggerPct 1 => trigger at 1310 B, so the small fixture clears it.
      // The default (80 => 104 KB) would skip this agent before the guard and
      // the test would pass for the wrong reason: zero results, zero processes.
      enabled: true, intervalMs: 60000, byteTriggerPct: 1,
      sectionTrigger: 99, recentKeep: 1, minBytes: 1024
    }),
    (ev) => { log.push(ev); }
  );
}

test('the absent project directory is reported as itself, not as an empty transcript', () => {
  withHome((home) => {
    const pre = transcriptPrecheck(home);
    assert.equal(pre.ok, false);
    assert.equal(pre.reason, 'project-dir-missing');
    assert.match(pre.detail, /\.claude[\\/]projects/);
  });
});

test('extractLastAssistantText still returns project-dir-missing (no regression)', () => {
  withHome((home) => {
    const r = extractLastAssistantText(home, Date.now());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'project-dir-missing');
  });
});

test('the guard is not vacuous: an existing project directory passes it', () => {
  withHome((home) => {
    // projectKey() munges the cwd (on win32 `F:\x` -> `F--x`). Rather than
    // reproduce that rule here, ask the function where it looks, then create
    // exactly that path.
    const first = transcriptPrecheck(home);
    assert.equal(first.ok, false, 'precondition must fail while the dir is absent');
    fs.mkdirSync(first.detail, { recursive: true });
    const second = transcriptPrecheck(home);
    assert.equal(second.ok, true, 'guard must pass once the directory exists');
    assert.equal(second.dir, first.detail);
  });
});

test('an absent project directory costs no process: the summarize branch is never entered', async () => {
  await withHome(async (home) => {
    const log = [];
    const results = await makeReflector(home, log).reflectNow();

    assert.equal(results.length, 1);
    assert.equal(results[0].condensed, false);
    assert.equal(results[0].reason, 'precondition-missing');

    // THE PROOF. `summarize-failed` is logged only from the catch around
    // `summarize`, so its absence means the Haiku run was never started.
    assert.equal(
      log.filter((e) => e.reason === 'summarize-failed').length, 0,
      'a summarize-failed line means the expensive branch ran — the guard did not hold'
    );
    const abort = log.find((e) => e.kind === 'condense-abort');
    assert.ok(abort, 'the exclusion must be recorded, not swallowed');
    assert.equal(abort.reason, 'precondition-missing');
    assert.match(abort.detail, /project-dir-missing/);
    assert.match(abort.detail, /\.claude[\\/]projects/);
  });
});

test('a standing condition is logged once, not once per tick', async () => {
  await withHome(async (home) => {
    const log = [];
    const r = makeReflector(home, log);
    await r.reflectNow();
    await r.reflectNow();
    await r.reflectNow();
    assert.equal(
      log.filter((e) => e.kind === 'condense-abort').length, 1,
      'three ticks, one line: a per-tick line is noise, not a record'
    );
  });
});

test('the reason is distinct from summarize-failed, so the two are not told apart again', async () => {
  await withHome(async (home) => {
    const log = [];
    const [res] = await makeReflector(home, log).reflectNow();
    assert.notEqual(res.reason, 'summarize-failed');
    assert.notEqual(res.reason, 'no-fresh-transcript');
    assert.notEqual(res.reason, 'no-assistant-text');
    assert.equal(res.reason, 'precondition-missing');
  });
});
