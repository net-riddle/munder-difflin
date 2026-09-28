'use strict';

// Task announcer — the START half, and the transition rule underneath both.
//
// It used to hold a Set of ids already seen as done. That cannot express
// "started": a card that is `doing` on every poll is either new (say it) or
// old (do not), and a Set of "seen" ids cannot tell those apart without
// remembering the previous STATUS. So the rule is now a transition:
//
//     previous status  →  new status   ⇒  say something
//
// Two announcements exist, and each has a state that must not repeat:
//   - → doing : "started"
//   - → done  : "finished"
//
// The silent failure mode of a notification is noise, not absence: a card that
// sits in `doing` for an hour must not be announced every 5 seconds.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { TaskDoneAnnouncer, transitionTo } = loadTs('src/main/taskDoneAnnouncer.ts');

function harness(initial = []) {
  const pushed = [];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: (id) => ({ 'oscar-mqp3l5wn': 'Oscar', 'jim-mugp1eoh': 'Jim' }[id] ?? null),
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  let cards = initial;
  return { a, pushed, set: (next) => { cards = next; }, poll: () => a.poll() };
}

const card = (id, status, title = 'do a thing') => ({ id, status, title, assignee: 'oscar-mqp3l5wn' });

// ── the baseline, which the START half must not break ───────────────────────

test('startup is still silent for a board full of work already in flight', () => {
  // The regression the start half invites: with 47 done cards and several in
  // `doing`, a naive implementation announces the whole floor on launch.
  const h = harness([
    card('t1', 'doing', 'a'), card('t2', 'doing', 'b'), card('t3', 'done', 'c'), card('t4', 'todo')
  ]);
  h.poll();
  assert.equal(h.pushed.length, 0);
});

test('a card moving todo → doing is announced as started', () => {
  const h = harness([card('t1', 'todo', 'fix the login bug')]);
  h.poll();
  h.set([card('t1', 'doing', 'fix the login bug')]);
  h.poll();
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0].kind, 'start');
  assert.equal(h.pushed[0].who, 'Oscar');
  assert.equal(h.pushed[0].title, 'fix the login bug');
});

test('a card moving doing → done is announced as finished', () => {
  const h = harness([card('t1', 'doing', 'fix the login bug')]);
  h.poll();
  h.set([card('t1', 'done', 'fix the login bug')]);
  h.poll();
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0].kind, 'done');
  assert.equal(h.pushed[0].who, 'Oscar');
  assert.equal(h.pushed[0].title, 'fix the login bug');
});

// ── the noise failures, which are the real risk ─────────────────────────────

test('a card that stays `doing` is announced once, not once per poll', () => {
  // It has to ENTER doing to count, so the card starts as todo and the first
  // poll after that is the event. Everything after is the same state repeated,
  // which is the whole point: this watcher runs every 5 seconds for as long as
  // the app is open.
  const h = harness([card('t1', 'todo')]);
  h.poll();
  h.set([card('t1', 'doing')]);
  h.poll();
  h.poll();
  h.poll();
  assert.equal(h.pushed.length, 1, 'only the transition is news');
  assert.equal(h.pushed[0].kind, 'start');
});

test('a card that was already running at startup never announces a start', () => {
  // The baseline absorbs it. Without this, every launch with work in flight
  // would open with "X started: …" for each of them.
  const h = harness([card('t1', 'doing')]);
  h.poll();
  h.poll();
  h.poll();
  assert.equal(h.pushed.length, 0);
});

test('one card can produce both halves, in order', () => {
  const h = harness([card('t1', 'todo', 'ship the release')]);
  h.poll();
  h.set([card('t1', 'doing', 'ship the release')]);
  h.poll();
  h.set([card('t1', 'done', 'ship the release')]);
  h.poll();
  assert.deepEqual(h.pushed.map((p) => p.kind), ['start', 'done']);
});

test('a reopened card is announced again when it restarts', () => {
  // done → doing → done is a genuine second run of the work, not a duplicate.
  // The old Set-of-done-ids shape could not express this: the id was already
  // in the set, so the second completion was silently swallowed.
  const h = harness([card('t1', 'done', 'flaky test')]);
  h.poll();
  h.set([card('t1', 'doing', 'flaky test')]);
  h.poll();
  h.set([card('t1', 'done', 'flaky test')]);
  h.poll();
  assert.deepEqual(h.pushed.map((p) => p.kind), ['start', 'done']);
});

test('todo and blocked are silent on their own', () => {
  // Only `doing` is a start and only `done` is a finish. A card created as
  // `todo` is a plan, not an event; `blocked` is a problem, not a start.
  const h = harness([]);
  h.poll();
  h.set([card('a', 'todo'), card('b', 'blocked')]);
  h.poll();
  h.poll();
  assert.equal(h.pushed.length, 0);
});

test('a card deleted and re-created under the same id is treated as new', () => {
  // Ids are reused in practice (per-agent task counters roll), so a card that
  // vanishes and comes back must not inherit the old one's history. The
  // re-created card arrives as `todo`, so entering `doing` is a real
  // transition and is announced — that is the property that matters.
  const h = harness([card('t1', 'doing')]);
  h.poll();
  h.set([]);
  h.poll();
  h.set([card('t1', 'todo')]);
  h.poll();
  h.set([card('t1', 'doing')]);
  h.poll();
  assert.equal(h.pushed.length, 1, 'the re-created card announces its start again');
  assert.equal(h.pushed[0].kind, 'start');
});

test('a re-created card already in `doing` is silent, not a phantom start', () => {
  // The flip side, and the reason the watcher is transition-based rather than
  // "anything I have not seen": a card that reappears mid-flight has no
  // observable start to report, and inventing one would be a lie.
  const h = harness([card('t1', 'doing')]);
  h.poll();
  h.set([]);
  h.poll();
  h.set([card('t1', 'doing')]);
  h.poll();
  assert.equal(h.pushed.length, 0);
});

test('a reader that throws skips the poll without announcing anything', () => {
  const pushed = [];
  const a = new TaskDoneAnnouncer({
    tasks: () => { throw new Error('tasks.json mid-write'); },
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  assert.doesNotThrow(() => a.poll());
  assert.equal(pushed.length, 0);
});

// ── the sentence is NOT built here any more ────────────────────────────────

test('the event carries facts, not a sentence', () => {
  // Main used to emit a ready-made English `summary`. It cannot localize it —
  // the chosen language lives in the renderer's localStorage — so the sentence
  // is composed in the renderer from these facts. What crosses IPC must be
  // data: a language-specific string built here would be a string main can never
  // get right.
  const h = harness([card('t1', 'todo', 'fix the login bug')]);
  h.poll();
  h.set([card('t1', 'done', 'fix the login bug')]);
  h.poll();
  const e = h.pushed[0];
  assert.equal(e.summary, undefined, 'no pre-rendered sentence may cross IPC');
  assert.equal(e.kind, 'done');
  assert.equal(e.who, 'Oscar');
  assert.equal(e.title, 'fix the login bug');
});

test('the only two transitions are start and done', () => {
  assert.equal(transitionTo('todo', 'doing'), 'start');
  assert.equal(transitionTo('doing', 'done'), 'done');
  assert.equal(transitionTo('blocked', 'done'), 'done');
  assert.equal(transitionTo('doing', 'doing'), null);
  assert.equal(transitionTo('done', 'doing'), 'start', 'a reopened card really does start again');
  assert.equal(transitionTo('done', 'done'), null);
  assert.equal(transitionTo('doing', 'todo'), null);
  assert.equal(transitionTo('done', 'blocked'), null);
});
