'use strict';

// Task-done announcer — the detection rule, without a voice session.
//
// This path exists to announce a finished task with NO OpenAI, so its whole
// value is firing at the right moment and staying quiet otherwise. Two failures
// matter and neither throws:
//
//   (a) announcing the entire existing board on startup — the classic bug of
//       "watch for done" written naively. Fifty historical cards would fire
//       fifty notifications before the user had done anything.
//   (b) re-announcing a card that is still done on the next poll — one
//       notification per poll interval, forever.
//
// Both are silent: no exception, no error, just noise. Hence these tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { TaskDoneAnnouncer, isDone, MAX_TITLE } = loadTs('src/main/taskDoneAnnouncer.ts');

/** A watcher over a mutable card list, collecting what it pushed. */
function harness(initial = []) {
  const pushed = [];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: (id) => ({ 'oscar-mqp3l5wn': 'Oscar', 'creed-abc': 'Creed' }[id] ?? null),
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  let cards = initial;
  return {
    a,
    pushed,
    set: (next) => { cards = next; },
    poll: () => a.poll()
  };
}

const card = (id, status, title = 'do a thing') => ({ id, status, title, assignee: 'oscar-mqp3l5wn' });

test('(a) the first poll is a baseline: an already-done board says nothing', () => {
  const h = harness([card('t1', 'done'), card('t2', 'done'), card('t3', 'done')]);
  h.poll();
  assert.equal(h.pushed.length, 0, 'startup must not replay history');
});

test('(a) a task that finishes AFTER startup is announced', () => {
  // The watcher is transition-based, so a finish is reported as the move
  // into `done` from any earlier state. `todo` is the realistic predecessor.
  const h = harness([card('t1', 'todo')]);
  h.poll();
  h.set([card('t1', 'done', 'fix the login bug')]);
  h.poll();
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0].kind, 'done');
  assert.equal(h.pushed[0].taskId, 't1');
  assert.equal(h.pushed[0].who, 'Oscar');
  assert.equal(h.pushed[0].title, 'fix the login bug');
});

test('(b) a card that stays done is announced exactly once', () => {
  const h = harness([card('t1', 'doing')]);
  h.poll();
  h.set([card('t1', 'done')]);
  h.poll();
  h.poll();
  h.poll();
  h.poll();
  assert.equal(h.pushed.length, 1, 'one notification per finished task, not per poll');
});

test('(b) a card leaving the board does not get re-announced when it returns', () => {
  const h = harness([card('t1', 'done')]);
  h.poll(); // baseline sees it
  h.set([]); // deleted
  h.poll();
  h.set([card('t1', 'done')]); // comes back, still done
  h.poll();
  assert.equal(h.pushed.length, 0);
});

test('only `done` counts — the other board states stay silent', () => {
  const h = harness([]);
  h.poll();
  h.set([card('a', 'todo'), card('b', 'doing'), card('c', 'blocked')]);
  h.poll();
  assert.equal(h.pushed.length, 0);
  h.set([card('a', 'DONE ')]); // hand-edited json: case + padding
  h.poll();
  assert.equal(h.pushed.length, 1, 'a done card in any casing counts');
});

test('a reader that throws skips the poll without breaking the loop', () => {
  const pushed = [];
  const a = new TaskDoneAnnouncer({
    tasks: () => { throw new Error('tasks.json mid-write'); },
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  a.poll(); // primed flag stays false, because we returned before setting it
  a.reset();
  assert.doesNotThrow(() => a.poll());
  assert.equal(pushed.length, 0);
});

test('disabled means fully silent, including the baseline', () => {
  // The first ENABLED poll is a baseline, so a card that finished while the
  // announcer was off is absorbed rather than announced late. Turning it on
  // must not dump the backlog at the user.
  const pushed = [];
  let on = false;
  const cards = [card('t1', 'todo')];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    push: (e) => pushed.push(e),
    enabled: () => on
  });
  a.poll();
  cards[0].status = 'done';
  a.poll();
  on = true;
  a.poll();
  assert.equal(pushed.length, 0);
  cards[0].status = 'todo';
  a.poll();
  cards[0].status = 'done';
  a.poll();
  assert.equal(pushed.length, 1);
});

// ── the spoken sentence ─────────────────────────────────────────────────────

test('the friendly name is preferred over the raw agent id', () => {
  // The spoken framing is built in the renderer now; what main supplies is the
  // name, and the friendly one is what makes a sentence legible out loud.
  const named = harness([card('t', 'todo', 'ship it')]);
  named.set.pushName = 'Oscar';
  named.poll();
  named.set([card('t', 'done', 'ship it')]);
  named.poll();
  assert.equal(named.pushed[0].who, 'Oscar');
});

test('an unresolvable agent id falls back to the raw id rather than nothing', () => {
  // nameOf returning null must not blank the name: "oscar-mqp3l5wn finished"
  // is usable, "" is not.
  const pushed = [];
  const cards = [{ id: 't', status: 'todo', title: 'x', assignee: 'ghost-999' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    nameOf: () => null,
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  a.poll();
  cards[0].status = 'done';
  a.poll();
  assert.equal(pushed[0].who, 'ghost-999');
});

test('a card with no assignee at all reports an empty name, not a crash', () => {
  const pushed = [];
  const cards = [{ id: 't', status: 'todo', title: 'x' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  a.poll();
  cards[0].status = 'done';
  a.poll();
  assert.equal(pushed[0].who, '');
});

test('a long card title is trimmed to something a voice can read', () => {
  // The renderer composes the sentence from these fields, so the bound has to
  // be enforced where the title is read — otherwise a 500-character objective
  // becomes a minute of speech.
  const pushed = [];
  const cards = [{ id: 't', status: 'todo', title: 'x'.repeat(500), assignee: 'a' }];
  const a = new TaskDoneAnnouncer({
    tasks: () => cards,
    push: (e) => pushed.push(e),
    enabled: () => true
  });
  a.poll();
  cards[0].status = 'done';
  a.poll();
  assert.ok(pushed[0].title.length <= MAX_TITLE, `title not bounded: ${pushed[0].title.length}`);
});

test('isDone tolerates the shapes a hand-edited tasks.json has', () => {
  assert.equal(isDone({ id: 'a', status: 'done' }), true);
  assert.equal(isDone({ id: 'a', status: ' DONE ' }), true);
  assert.equal(isDone({ id: 'a', status: 'Done' }), true);
  assert.equal(isDone({ id: 'a', status: 'doing' }), false);
  assert.equal(isDone({ id: 'a' }), false);
  assert.equal(isDone({ id: 'a', status: 'done-ish' }), false);
});
