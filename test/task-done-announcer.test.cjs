'use strict';

/**
 * Task announcements: the card that goes `blocked` used to be silent.
 *
 * The user hears a sound when work starts and when work finishes. When a card
 * went `blocked` — the one moment the human is actually needed — the announcer
 * said nothing, because `transitionTo` only knew `doing` and `done`. That is a
 * missing signal, not an ergonomics detail: the gap is exactly where attention
 * is required.
 *
 * THREE THINGS HAVE TO BE TRUE, and testing only the first is how you ship an
 * event that arrives and says nothing:
 *
 *   1. main emits it      — `transitionTo` and the poller must produce `blocked`.
 *   2. the renderer says it — the sentence is composed in the RENDERER (the
 *      chosen language lives in its localStorage and main never sees it), so a
 *      main-only change ships an event that is received and dropped.
 *   3. the words exist    — in every locale, with the interpolation placeholders
 *      the family already uses.
 *
 * This is the first test for src/main/taskDoneAnnouncer.ts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const LOCALES = ['en', 'it', 'zh-CN', 'ar'];

// ── main: the transition table ───────────────────────────────────────────────

const mod = loadMain();
const { transitionTo, TaskDoneAnnouncer } = mod;

/** Transpile taskDoneAnnouncer.ts standalone: its only import is type-only. */
function loadMain() {
  const ts = require('typescript');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'task-ann-'));
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, 'src', 'main', 'taskDoneAnnouncer.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
  ).outputText;
  fs.writeFileSync(path.join(out, 'taskDoneAnnouncer.js'), js, 'utf8');
  return require(path.join(out, 'taskDoneAnnouncer.js'));
}

test('entering blocked is an event, from every status that can precede it', () => {
  for (const prev of ['todo', 'doing', 'in_progress', '']) {
    assert.equal(transitionTo(prev, 'blocked'), 'blocked',
      `blocked after "${prev}" must announce`);
  }
});

test('the pre-existing events still fire, and still do not fire on noise', () => {
  assert.equal(transitionTo('todo', 'doing'), 'start');
  assert.equal(transitionTo('doing', 'done'), 'done');
  // unchanged status, and the movements that are not news
  for (const [p, n] of [['blocked', 'blocked'], ['doing', 'todo'], ['done', 'todo'], ['blocked', 'todo']]) {
    assert.equal(transitionTo(p, n), null, `${p} -> ${n} must stay silent`);
  }
});

test('the poller pushes a blocked event when a card goes doing -> blocked', () => {
  const events = [];
  let cards = [{ id: 'c1', status: 'todo', title: 'A', assignee: 'jim-mugp1eoh' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: (id) => (id === 'jim-mugp1eoh' ? 'Jim' : null),
    push: (e) => events.push(e),
    enabled: () => true
  });
  a.poll();                                    // baseline: the board as it stands
  assert.equal(events.length, 0, 'priming must not announce the existing floor');

  cards = [{ id: 'c1', status: 'doing', title: 'A', assignee: 'jim-mugp1eoh' }];
  a.poll();
  assert.equal(events.at(-1).kind, 'start');

  cards = [{ id: 'c1', status: 'blocked', title: 'A', assignee: 'jim-mugp1eoh' }];
  a.poll();
  // 1 start + 1 blocked. NOT 3: the priming poll announces nothing.
  assert.equal(events.length, 2, 'going blocked is the moment the human is needed');
  const blocked = events.at(-1);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.who, 'Jim');
  assert.equal(blocked.title, 'A');
  assert.equal(blocked.taskId, 'c1');

  a.poll();                                    // sitting still is not news
  assert.equal(events.length, 2, 'a card that stays blocked must not re-announce');
});

// The decision this encodes, asserted so it cannot be quietly reversed later:
// doing -> blocked is TWO announcements, and that is deliberate. `start` says
// work began; `blocked` says a human is needed. They are different facts, so the
// second is not a repeat. What would be noise is re-announcing an unchanged
// card, and `seen` already prevents that (asserted above).

test('DECISION: doing -> blocked speaks twice, because the two are different facts', () => {
  assert.equal(transitionTo('todo', 'doing'), 'start');
  assert.equal(transitionTo('doing', 'blocked'), 'blocked');
});

// A card that APPEARS already blocked is not announced, and that is this module's
// documented behaviour, not an accident: a card appearing mid-run has no baseline
// to compare against, so there is no transition to report. Pinned here because it
// is the one place where "a card is blocked" and "the user was told" disagree —
// see the note in the report: a card CREATED directly in `blocked` is silent.
test('a card appearing already-blocked mid-run is silent (no baseline, no transition)', () => {
  const events = [];
  let cards = [];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards, push: (e) => events.push(e), enabled: () => true
  });
  a.poll();
  cards = [{ id: 'c2', status: 'blocked', title: 'B' }];
  a.poll();
  assert.equal(events.length, 0,
    'documented rule: "a card that appeared mid-run: no baseline to compare against"');
});

test('a card that exists and THEN blocks announces blocked exactly once', () => {
  const events = [];
  let cards = [{ id: 'c3', status: 'todo', title: 'C' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards, push: (e) => events.push(e), enabled: () => true
  });
  a.poll();
  cards = [{ id: 'c3', status: 'blocked', title: 'C' }];
  a.poll();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'blocked', 'and never a phantom start: it never entered doing');
});

// ── 094: a card that cannot be NAMED is recorded, not announced ───────────────

test('094: an unnameable agent is NOT announced at all, and is recorded instead', () => {
  // The direction was the user's, in as many words: the id must stop being said.
  // `whoOf` used to answer that with the raw id, so the only two ways out were
  // speaking the id or inventing a name. So the card is not announced: the
  // `*Unnamed` sentences exist and would be spoken for a card with nobody
  // assigned, but here somebody IS assigned and we simply cannot name them, and
  // a nameless announcement would hide a name that stopped resolving.
  const events = [];
  const unnamed = [];
  let cards = [{ id: 'c4', status: 'doing', title: 'D', assignee: 'jim-mugp1eoh' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: () => null,                      // the lookup that used to fail
    push: (e) => events.push(e),
    unnamed: (e) => unnamed.push(e),
    enabled: () => true
  });
  a.poll();                                  // baseline
  cards = [{ id: 'c4', status: 'done', title: 'D', assignee: 'jim-mugp1eoh' }];
  a.poll();

  assert.equal(events.length, 0, 'nothing may be announced when the name is unresolvable');
  assert.equal(unnamed.length, 1, 'and the transition is still recorded');
  assert.equal(unnamed[0].assignee, 'jim-mugp1eoh',
    'the id is kept in the record, where a human can read it — it is only the SPEAKER that never sees it');
  assert.equal(unnamed[0].kind, 'done');
  assert.equal(unnamed[0].title, 'D');
  const spoken = JSON.stringify(unnamed[0]);
  assert.ok(!/announc|speak/i.test(spoken), 'the record is not a sentence to be spoken');
});

test('094: a card with NOBODY assigned is still announced, without a who', () => {
  // The distinction the previous code did not make: an unassigned card is a
  // normal thing, and the `*Unnamed` sentences are for it. Only a card that HAS
  // an assignee we cannot name is the defect. Collapsing the two would silence
  // every unassigned card on the floor to fix one broken lookup.
  const events = [];
  const unnamed = [];
  let cards = [{ id: 'c5', status: 'doing', title: 'E' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: () => null,
    push: (e) => events.push(e),
    unnamed: (e) => unnamed.push(e),
    enabled: () => true
  });
  a.poll();
  cards = [{ id: 'c5', status: 'done', title: 'E' }];
  a.poll();
  assert.equal(events.length, 1, 'an unassigned card is announced as before');
  assert.equal(events[0].who, '');
  assert.equal(unnamed.length, 0, 'and it is not a name failure');
});

test('094: a recorder that throws does not stop the poll loop', () => {
  // Same trade as `push`: the status is already remembered, so this transition
  // is not retried, and a throwing recorder must not cost every later card.
  const events = [];
  let cards = [{ id: 'c6', status: 'doing', title: 'F', assignee: 'nobody-here9' },
    { id: 'c7', status: 'doing', title: 'G', assignee: 'jim-mugp1eoh' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: (id) => (id === 'jim-mugp1eoh' ? 'Jim' : null),
    push: (e) => events.push(e),
    unnamed: () => { throw new Error('recorder is down'); },
    enabled: () => true
  });
  a.poll();
  cards = [
    { id: 'c6', status: 'done', title: 'F', assignee: 'nobody-here9' },
    { id: 'c7', status: 'done', title: 'G', assignee: 'jim-mugp1eoh' }
  ];
  a.poll();
  assert.equal(events.length, 1, 'the card AFTER the throwing one is still announced');
  assert.equal(events[0].who, 'Jim');
});

// ── renderer: the sentence, which main cannot write ──────────────────────────

test('the renderer routes kind=blocked to its own keys, never to the finished ones', () => {
  const loadTs = require('./load-ts.cjs');
  globalThis.window = { cth: { onTaskDone: () => {} } };
  globalThis.Audio = class { pause() {} removeAttribute() {} play() { return Promise.resolve(); } addEventListener() {} setSinkId() { return Promise.resolve(); } };

  // Observe the KEYS the code asks i18next for. announceSentence calls `i18n.t`
  // at invocation time on the real singleton, so recording the requests is a
  // non-vacuous assertion of the routing. (Asserting the returned STRING would
  // be worthless here: an uninitialised i18next returns undefined for every key,
  // so blocked and done would compare equal and the test would pass whatever
  // the code did. The wording itself is asserted from the locale files below.)
  const i18next = require('i18next');
  const i18n = i18next.default ?? i18next;
  const asked = [];
  const realT = i18n.t.bind(i18n);
  i18n.t = (key, opts) => { asked.push(key); return realT(key, opts); };
  try {
    const { announceSentence } = loadTs('src/renderer/src/realtime/announcer.ts');

    assert.equal(announceSentence({ kind: 'blocked', who: 'Jim', title: 'A' }), undefined);
    assert.equal(asked.pop(), 'announce.blocked');

    assert.equal(announceSentence({ kind: 'blocked', who: '', title: 'A' }), undefined);
    assert.equal(asked.pop(), 'announce.blockedUnnamed');
    assert.equal(announceSentence({ kind: 'blocked', who: 'Jim', title: '' }), undefined);
    assert.equal(asked.pop(), 'announce.blockedNoTitle');
    assert.equal(announceSentence({ kind: 'blocked', who: '', title: '' }), undefined);
    assert.equal(asked.pop(), 'announce.blockedBare');

    // The one that matters most: a blocked card must never be rendered with the
    // finished wording, which would tell the user the opposite of the truth.
    announceSentence({ kind: 'blocked', who: 'Jim', title: 'A' });
    assert.ok(!asked.includes('announce.finished'),
      `blocked rendered through a finished key: ${asked.join(', ')}`);

    // and the pre-existing routing is unchanged
    asked.length = 0;
    announceSentence({ kind: 'start', who: 'Jim', title: 'A' });
    assert.equal(asked.pop(), 'announce.started');
    asked.length = 0;
    announceSentence({ kind: 'done', who: 'Jim', title: 'A' });
    assert.equal(asked.pop(), 'announce.finished');
  } finally {
    i18n.t = realT;
  }
});

// ── locales: the words have to exist, in every language ─────────────────────

test('every locale carries the blocked family, with the family placeholders', () => {
  const KEYS = ['blocked', 'blockedUnnamed', 'blockedNoTitle', 'blockedBare'];
  for (const code of LOCALES) {
    const json = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'i18n', 'locales', `${code}.json`), 'utf8'));
    for (const k of KEYS) {
      const v = json.announce?.[k];
      assert.equal(typeof v, 'string', `${code}: announce.${k} is missing`);
      assert.ok(v.trim().length > 0, `${code}: announce.${k} is empty`);
    }
    assert.ok(json.announce.blocked.includes('{{who}}'), `${code}: announce.blocked lost {{who}}`);
    assert.ok(json.announce.blocked.includes('{{title}}'), `${code}: announce.blocked lost {{title}}`);
    assert.ok(json.announce.blockedUnnamed.includes('{{title}}'), `${code}: announce.blockedUnnamed lost {{title}}`);
    assert.ok(json.announce.blockedNoTitle.includes('{{who}}'), `${code}: announce.blockedNoTitle lost {{who}}`);
    // the new keys must not use a placeholder its shape does not carry
    assert.ok(!json.announce.blockedBare.includes('{{'), `${code}: announce.blockedBare must stay bare`);
  }
});

test('every locale keeps the pre-existing announcement keys', () => {
  const KEYS = ['finished', 'finishedNoTitle', 'finishedUnnamed', 'finishedBare',
    'started', 'startedNoTitle', 'startedUnnamed', 'startedBare'];
  for (const code of LOCALES) {
    const json = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'i18n', 'locales', `${code}.json`), 'utf8'));
    for (const k of KEYS) {
      assert.equal(typeof json.announce?.[k], 'string', `${code}: announce.${k} disappeared`);
    }
  }
});
