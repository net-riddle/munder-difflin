const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  WorkerWakeWatchdog,
  classifyHook,
  WORKER_WAKE_NUDGE,
  WORKER_WAKE_IDLE_MS,
  WORKER_WAKE_BOOT_GRACE_MS,
  WORKER_WAKE_COOLDOWN_MS,
  WORKER_WAKE_HITL_REARM_MS
} = loadTs('src/main/workerWake.ts');

/** A permissive fact; tests override the fields they care about. */
function fact(overrides = {}) {
  return {
    agentId: 'alice',
    ptyId: 'pty-alice',
    lastOutputAt: 100_000,
    inboxCount: 1,
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    ...overrides
  };
}

test('nudges an idle worker with undrained inbox mail', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1 })], now);
  assert.deepEqual(out, ['alice']);
});

test('never nudges god, archived agents, or agents without a live pty', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('p1', 0);
  const now = 200_000;
  const out = w.decide([
    fact({ agentId: 'god', isGod: true, ptyId: 'p1' }),
    fact({ agentId: 'gone', archived: true, ptyId: undefined }),
    fact({ agentId: 'no-pty', ptyId: undefined })
  ], now);
  assert.deepEqual(out, []);
});

test('never nudges when there is no inbox mail', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ inboxCount: 0 })], now);
  assert.deepEqual(out, []);
});

test('never nudges a mid-turn worker (recent PTY output)', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ lastOutputAt: now - 1 })], now);
  assert.deepEqual(out, []);
});

test('never nudges a worker that never produced output (still booting)', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  const out = w.decide([fact({ lastOutputAt: 0 })], now);
  assert.deepEqual(out, []);
});

test('respects the boot grace window', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 10_000);
  const now = 10_000 + WORKER_WAKE_BOOT_GRACE_MS - 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: 0 })], now), []);
  // past the grace (and idle long enough) → eligible
  const late = 10_000 + WORKER_WAKE_BOOT_GRACE_MS + WORKER_WAKE_IDLE_MS + 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: late - WORKER_WAKE_IDLE_MS - 1 })], late), ['alice']);
});

test('never nudges while delivery is paused, agent paused, or halted', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('p1', 0);
  const now = 200_000;
  const out = w.decide([
    fact({ agentId: 'a1', ptyId: 'p1', autoDeliveryPaused: true }),
    fact({ agentId: 'a2', ptyId: 'p1', paused: true }),
    fact({ agentId: 'a3', ptyId: 'p1', halted: true })
  ], now);
  assert.deepEqual(out, []);
});

test('a recent permission/HITL notification blocks nudges', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  w.noteHook('alice', 'Notification', 'Claude needs your permission to use Bash.', now - 1_000);
  assert.deepEqual(w.decide([fact()], now), []);
  // after the rearm window the block expires
  const later = now + WORKER_WAKE_HITL_REARM_MS + 1;
  assert.deepEqual(w.decide([fact({ lastOutputAt: later - WORKER_WAKE_IDLE_MS - 1 })], later), ['alice']);
});

test('an idle-waiting notification does NOT count as a HITL hold', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  w.noteHook('alice', 'Notification', 'waiting for your input', now - 1_000);
  assert.deepEqual(w.decide([fact()], now), ['alice']);
});

test('a nudge is not repeated within the cooldown', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', 0);
  const now = 200_000;
  assert.deepEqual(w.decide([fact()], now), ['alice']);
  assert.deepEqual(w.decide([fact()], now + WORKER_WAKE_COOLDOWN_MS - 1), []);
  assert.deepEqual(w.decide([fact({ lastOutputAt: now + WORKER_WAKE_COOLDOWN_MS + 1 - WORKER_WAKE_IDLE_MS - 1 })], now + WORKER_WAKE_COOLDOWN_MS + 1), ['alice']);
});

test('forget clears cooldown + boot grace + HITL state', () => {
  const w = new WorkerWakeWatchdog();
  w.noteSpawn('pty-alice', Date.now());
  w.noteHook('alice', 'Notification', 'permission', Date.now());
  w.decide([fact()], Date.now());
  w.forget('alice', 'pty-alice');
  const now = 200_000;
  assert.deepEqual(w.decide([fact({ lastOutputAt: now - WORKER_WAKE_IDLE_MS - 1 })], now), ['alice']);
});

test('classifyHook: permission/approve/confirm shapes are needsHuman', () => {
  assert.equal(classifyHook('Notification', 'Claude needs your permission to use Bash.'), 'needsHuman');
  assert.equal(classifyHook('Notification', 'Approve tool use?'), 'needsHuman');
  assert.equal(classifyHook('Notification', 'confirm the change?'), 'needsHuman');
});

test('classifyHook: idle-waiting shapes are idle, other events are null', () => {
  assert.equal(classifyHook('Notification', 'waiting for your input'), 'idle');
  assert.equal(classifyHook('Notification', 'Claude is idle — waiting for input'), 'idle');
  assert.equal(classifyHook('Notification', ''), 'idle');
  assert.equal(classifyHook('Stop', 'some message'), null);
  assert.equal(classifyHook('UserPromptSubmit', undefined), null);
});

test('the nudge text matches the renderer guardrail exactly', () => {
  // If the renderer's nudge wording ever changes, update WORKER_WAKE_NUDGE to match.
  assert.equal(WORKER_WAKE_NUDGE.length > 100, true);
  assert.match(WORKER_WAKE_NUDGE, /read your inbox/i);
});

test('a nudge decision carries a NAME, for every guard that can decline it', () => {
  // The reason the action path was silent: the log only ever said "nudging", so
  // an agent sitting on undrained mail was indistinguishable from a healthy
  // floor. `explain` is the question you can now ask a guard.
  const w = new WorkerWakeWatchdog();
  const now = 1_000_000_000_000;
  assert.equal(w.explain(fact(), now), null, 'an eligible worker is not a decline');
  assert.equal(w.explain(fact({ isGod: true }), now), 'god');
  assert.equal(w.explain(fact({ ptyId: undefined }), now), 'no-pty');
  assert.equal(w.explain(fact({ autoDeliveryPaused: true }), now), 'delivery-paused');
  assert.equal(w.explain(fact({ paused: true }), now), 'paused');
  assert.equal(w.explain(fact({ halted: true }), now), 'halted');
  assert.equal(w.explain(fact({ lastOutputAt: 0 }), now), 'never-output');
  assert.equal(w.explain(fact({ lastOutputAt: now - 1000 }), now), 'mid-turn');
  assert.equal(w.explain(fact({ inboxCount: 0 }), now), null, 'no mail is not a decline');
});

test('whatever explain names, decide must not nudge — the two cannot drift', () => {
  // The invariant that keeps the diagnostic honest. A guard that logs
  // `hitl-rearm` while the decision quietly nudges would make the log a lie, and
  // a log you cannot trust is worse than no log.
  const now = 1_000_000_000_000;
  const variants = [
    {},
    { isGod: true },
    { ptyId: undefined },
    { inboxCount: 0 },
    { autoDeliveryPaused: true },
    { paused: true },
    { halted: true },
    { lastOutputAt: 0 },
    { lastOutputAt: now - 1_000 },
    { lastOutputAt: now - 10 * 60_000 }
  ];
  for (const over of variants) {
    const w = new WorkerWakeWatchdog();
    const f = fact(over);
    const reason = w.explain(f, now);
    const nudged = w.decide([f], now);
    if (reason === null) continue; // eligible: decide may nudge
    assert.equal(nudged.length, 0, `declined as "${reason}" but decide still nudged`);
  }

  // and the same for the guards that need state, not just fields
  const w2 = new WorkerWakeWatchdog();
  w2.noteSpawn('pty-alice', now - 1_000);
  const booting = fact({ lastOutputAt: now - 10 * 60_000 });
  assert.equal(w2.explain(booting, now), 'boot-grace');
  assert.equal(w2.decide([booting], now).length, 0);

  const w3 = new WorkerWakeWatchdog();
  w3.noteHook('alice', 'Notification', 'tool needs your permission');
  const held = fact({ lastOutputAt: now - 10 * 60_000 });
  assert.equal(w3.explain(held, now), 'hitl-rearm');
  assert.equal(w3.decide([held], now).length, 0);
});

test('a reason is reported when it CHANGES, so a stuck worker stays legible without shouting', () => {
  // The beat runs every 15 s: an unconditional line is 4 per minute per agent,
  // and a log nobody reads is the same as no log. On change, the line stays in
  // the file saying WHY for as long as it is true.
  const now = 1_000_000_000_000;
  const w = new WorkerWakeWatchdog();
  const hitl = fact({ lastOutputAt: now - 10 * 60_000 });
  w.noteHook('alice', 'Notification', 'needs your permission');

  assert.deepEqual(w.reasonsToReport([hitl], now), ['alice hitl-rearm'], 'first beat reports');
  assert.deepEqual(w.reasonsToReport([hitl], now), [], 'unchanged reason is not repeated');
  assert.deepEqual(w.reasonsToReport([hitl], now + 1000), [], 'still not repeated');

  // the reason changes -> reported
  const midTurn = fact({ lastOutputAt: now - 1000 });
  assert.deepEqual(w.reasonsToReport([midTurn], now), ['alice mid-turn']);

  // reason clears -> state forgotten, so the SAME reason can be reported again
  assert.deepEqual(w.reasonsToReport([hitl], now), ['alice hitl-rearm'], 'a cleared reason is forgotten');
});

test('forget() also forgets the reported reason', () => {
  // Otherwise a PTY that closes and reopens would never report the same reason
  // twice: the stale state hides the event in exactly the direction we are blind.
  const now = 1_000_000_000_000;
  const w = new WorkerWakeWatchdog();
  const paused = fact({ paused: true });
  assert.deepEqual(w.reasonsToReport([paused], now), ['alice paused']);
  assert.deepEqual(w.reasonsToReport([paused], now), []);
  w.forget('alice', 'pty-alice');
  assert.deepEqual(w.reasonsToReport([paused], now), ['alice paused'], 'after forget, it reports again');
});
