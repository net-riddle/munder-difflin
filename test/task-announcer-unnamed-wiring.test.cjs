'use strict';

/**
 * 096: the `unnamed` dep is OPTIONAL, nobody passed it, and a card whose agent
 * cannot be named was therefore neither spoken NOR written down.
 *
 * WHY THIS FILE EXISTS AT ALL, because `task-done-announcer.test.cjs` already
 * proves the module's behaviour and I did not come to write it twice:
 *
 *   - line 141  `094: an unnameable agent is NOT announced at all, and is recorded`
 *   - line 172  `094: a card with NOBODY assigned is still announced, without a who`
 *   - line 195  `094: a recorder that throws does not stop the poll loop`
 *
 * All three pass, and they are not the gap. The gap was the CALLER:
 * `index.ts:4476` built the announcer with `tasks`, `nameOf`, `push` and
 * `enabled` and no `unnamed`, and `taskDoneAnnouncer.ts:289` calls it as
 * `this.deps.unnamed?.({...})`. An optional dep that nobody passes is not a dep —
 * the call vanishes without an error, which is the same shape as a shape
 * assumption wrapped in a `catch`: it does not fail, it produces a wrong answer
 * that still looks like an answer. Here the wrong answer is "nothing happened",
 * and nothing happening is exactly what a fixed defect looks like.
 *
 * TWO CHECKS, AND ONE ALONE IS NOT ENOUGH (the 057 rule: two DISTINCT
 * verifications, not one test twice):
 *
 *   1. BEHAVIOURAL, with the real module and the recorder shape the app really
 *      uses — not an array of my own. If tomorrow the recorder stops carrying
 *      `assignee`, this goes red. It cannot see whether `index.ts` still passes
 *      the dep, so it is check 2's job.
 *   2. WIRING, on the source of `index.ts`. `index.ts` imports electron and is
 *      not loadable in a test, so a source-level check is the most this can look
 *      at. THAT IS A LIMIT, NOT A COAT OF PAINT: check 2 proves the app is WIRED
 *      to the recorder, not that the app records. Saying so in the test name is
 *      part of the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'main', 'index.ts');

/** Transpile the announcer standalone, the same way its own test does. */
function loadAnnouncer() {
  const ts = require('typescript');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'unnamed-096-'));
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, 'src', 'main', 'taskDoneAnnouncer.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
  ).outputText;
  fs.writeFileSync(path.join(out, 'taskDoneAnnouncer.js'), js, 'utf8');
  return require(path.join(out, 'taskDoneAnnouncer.js'));
}

/**
 * The recorder AS `index.ts` NOW WRITES IT, against a real log file.
 *
 * Copied from the call site on purpose: a test that builds its own recorder tests
 * the test. This one writes the same `log.jsonl` shape the app writes, so if the
 * app's recorder ever drops a field, the field is missing HERE too — and the
 * assertion below notices. The `kind`/`transition` rename is the same one, and it
 * is the reason `transition` is a separate field at all.
 */
function appRecorder(logPath) {
  return ({ kind, ...e }) => {
    fs.appendFileSync(logPath, JSON.stringify({ kind: 'task-unnamed', transition: kind, ...e }) + '\n', 'utf8');
  };
}

// ── 1. BEHAVIOURAL: the record exists, carries the id, and is not a sentence ──

test('096: a card whose agent cannot be named is NOT spoken, and the record that replaces it carries the id', () => {
  const { TaskDoneAnnouncer } = loadAnnouncer();
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unnamed-log-')), 'log.jsonl');
  const spoken = [];

  let cards = [{ id: 'u1', status: 'doing', title: 'Una card', assignee: 'jim-mugp1eoh' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: () => null,                       // the lookup that fails
    push: (e) => spoken.push(e),              // the voice
    unnamed: appRecorder(logPath),            // the record, the app's own shape
    enabled: () => true
  });
  a.poll();                                   // baseline
  cards = [{ id: 'u1', status: 'done', title: 'Una card', assignee: 'jim-mugp1eoh' }];
  a.poll();

  assert.equal(spoken.length, 0, 'nothing may reach the voice when the name is unresolvable');

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'THE RECORD EXISTS. A card that was not spoken and not written down is a disappearance, and a disappearance that looks like a fix is worse than the defect it replaced.');
  const rec = JSON.parse(lines[0]);

  assert.equal(rec.kind, 'task-unnamed', 'the record says what kind of fact it is');
  assert.equal(rec.transition, 'done', 'and the TRANSITION is kept: the event kind and the transition are two facts, and the rename is what stops the second overwriting the first');
  assert.equal(rec.assignee, 'jim-mugp1eoh', 'the id is in the record, which is the whole point: it is the only place somebody can read it');
  assert.equal(rec.taskId, 'u1', 'and which card it was, so the record is actionable and not just a name that stopped resolving');
  assert.equal(typeof rec.title, 'string');
  assert.ok(Number.isFinite(rec.at), 'with a time, so a record nobody can order is a log of noise');

  // The one that matters to the human: this line must never be a sentence.
  assert.ok(!/announc|speak|voice|say\b/i.test(JSON.stringify(rec)),
    'the record is not something to say out loud — if it were, the id would be spoken by the back door');
});

test('096: a card with NOBODY assigned is still announced — the two cases must not merge', () => {
  // The distinction Kelly fixed and the refactor threatened: an unassigned card is
  // normal and the `*Unnamed` sentences are FOR it. Only a card that HAS an
  // assignee we cannot name is the defect. Unifying the two would silence every
  // unassigned card on the floor to repair one broken lookup, and the silence
  // would look exactly like success.
  const { TaskDoneAnnouncer } = loadAnnouncer();
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unnamed-log-')), 'log.jsonl');
  const spoken = [];

  let cards = [{ id: 'u2', status: 'doing', title: 'Nessuno assegnato' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: () => null,
    push: (e) => spoken.push(e),
    unnamed: appRecorder(logPath),
    enabled: () => true
  });
  a.poll();
  cards = [{ id: 'u2', status: 'done', title: 'Nessuno assegnato' }];
  a.poll();

  assert.equal(spoken.length, 1, 'an unassigned card is announced, exactly as before');
  assert.equal(spoken[0].who, '', 'with an empty who, which the *Unnamed sentences exist to say');
  assert.equal(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim() : '', '',
    'and it is NOT a name failure, so nothing is written to the record');
});

// ── 2. WIRING: index.ts actually passes it. A limit, declared. ─────────────

test('096 WIRING (source-level, not behavioural): index.ts passes an `unnamed` recorder, and it reaches appendLog', () => {
  const src = fs.readFileSync(INDEX, 'utf8');
  const start = src.indexOf('new TaskDoneAnnouncer({');
  assert.ok(start > 0, 'index.ts must still construct a TaskDoneAnnouncer');
  // The deps object ends at the first `});` at column 0 after the construction.
  const fine = src.indexOf('\n});', start);
  assert.ok(fine > start, 'the construction must be closed');
  const deps = src.slice(start, fine);

  const at = deps.indexOf('unnamed:');
  assert.ok(at > 0,
    'THE DEFECT: index.ts builds the announcer without an `unnamed` dep. An optional dep that nobody passes is not a dep — `this.deps.unnamed?.(...)` vanishes with no error, the card is neither spoken nor recorded, and that looks exactly like a fixed defect. THIS is what the first check above cannot see.');

  const corpo = deps.slice(at, deps.indexOf('});', at) > 0 ? deps.indexOf('});', at) : deps.length);
  assert.match(corpo, /appendLog\(/,
    'the recorder must reach `hive.appendLog`, the app\'s append-only feed: a record in a place nobody reads is a record that does not exist');
  assert.ok(!/console\.(log|info|warn|error)\(/.test(corpo),
    'and not the console: stdout is not durable, and not something a human goes looking for');

  // The voice must not receive it. This is the direction the user asked for.
  const push = deps.slice(deps.indexOf('push:'), at > 0 ? at : deps.length);
  assert.ok(!/task-unnamed/.test(push),
    'the record must not also be pushed: `appendLog` is the record and `push` is the voice, and the id must not reach the speaker by either door');
  assert.match(deps, /appendLog\(\{ kind: 'task-unnamed'/,
    'the event kind is its own field, so a consumer can tell a name that stopped resolving from a task that finished');
  assert.match(corpo, /transition: kind/,
    'and the transition keeps its own name, because `e.kind` would otherwise overwrite the event kind in the only place the transition is written down');
});
