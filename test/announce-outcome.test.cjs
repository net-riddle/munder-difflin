'use strict';
/**
 * task-jim-060 — what became of a spoken announcement must not be thrown away.
 *
 * THE FACT THAT EXISTED AND WAS DISCARDED. `playClip()` settles on the media
 * element's own `ended` / `error` event, and `speakImpl` awaits it — so the
 * renderer has always known whether the user heard the line. But `speakLine()`
 * was declared `: void`, and that is the entire mechanism by which the fact
 * stopped: not a missing capability, a return type. Every one of playClip's
 * seven exits called the same `done()` and resolved `undefined`.
 *
 * WHY THREE OUTCOMES AND NOT A BOOLEAN. The exits are not two kinds of thing:
 *
 *   'ended'                 the user heard the whole line        -> played
 *   barge-in / generation  playback began, will not finish       -> cut-short
 *   hard-stop watchdog      a long clip truncated                -> cut-short
 *   'error'                 nothing was audible                  -> failed
 *   decode failure          nothing was audible                  -> failed
 *   autoplay refused        nothing was audible                  -> failed
 *
 * Collapsing the middle two into `played` is how a voice tells someone they
 * heard a message at the exact moment they were not listening. A boolean would
 * have to lie about one of them, so it does not exist.
 *
 * These are the tests the card points at: the in-process half cannot be checked
 * by hand without the human's restart, so the test IS the proof, and calling it
 * finished without running it would be the unverified patch the human's rule
 * forbids.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

// ── controllable doubles, installed BEFORE the module is loaded ──────────────
// `load-ts.cjs` evaluates modules with `new Function`, so their `Audio`, `atob`,
// `URL` and `window` resolve to Node's globals. Setting them here is therefore
// how the module is given a browser, and it is why one module load serves every
// test: the fakes read from `ctl`, which each test reconfigures.
const ctl = {
  /** What the element does when playback starts. */
  mode: 'ended', // 'ended' | 'error' | 'reject' | 'hang'
  /** Whether the TTS call succeeds. */
  speakOk: true,
  /** Every element the module has constructed, in order. */
  made: [],
  /** How many clips have been PLAYED — not how many elements exist. `ensureSink`
   *  caches one <audio> for the whole session, so the element count is 1 forever
   *  and cannot be used to count clips. */
  played: 0
};

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.autoplay = false;
    this.preload = '';
    this.src = '';
    ctl.made.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((f) => f !== fn));
  }
  fire(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn();
  }
  pause() { /* a pause fires no event, which is the whole cancel problem */ }
  play() {
    ctl.played += 1;
    if (ctl.mode === 'reject') return Promise.reject(new Error('autoplay refused'));
    if (ctl.mode === 'hang') return Promise.resolve(); // settles only on a cancel
    const type = ctl.mode;
    queueMicrotask(() => this.fire(type));
    return Promise.resolve();
  }
}

globalThis.Audio = FakeAudio;
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.URL.createObjectURL = () => 'blob:fake-clip';
globalThis.URL.revokeObjectURL = () => { /* per-clip revoke, nothing to free */ };
globalThis.window = {
  cth: {
    realtimeSpeak: async () => (ctl.speakOk
      ? { ok: true, audio: '', mime: 'audio/wav' }
      : { ok: false, error: 'tts server is down' }),
    realtimeLogError: async () => ({ ok: true })
  }
};

const mod = loadTs('src/renderer/src/realtime/localVoice.ts');

/** Settle any residue so one test cannot leak a pending clip into the next. */
async function reset() {
  mod.stopLocalVoice();
  ctl.made.length = 0;
  ctl.played = 0;
  ctl.mode = 'ended';
  ctl.speakOk = true;
}

// i18next is a singleton and this file is not about wording: an UNINITIALISED
// i18next returns `undefined` for every key, which would make `announceSentence`
// return undefined and the announcer bail out before speaking — the test would
// then pass for the wrong reason. (The neighbouring test file says the same
// thing about asserting the string: it is worthless here, and the routing is
// asserted there instead.) Returning the key gives a non-empty sentence.
const i18next = require('i18next');
const i18n = i18next.default ?? i18next;
i18n.t = (key) => key;

// ── the three outcomes ───────────────────────────────────────────────────────

test('a clip that reaches its own ended is reported PLAYED', async () => {
  await reset();
  ctl.mode = 'ended';
  assert.equal(await mod.speakLine('Ciao.'), 'played');
});

test('an error event is reported FAILED, not played', async () => {
  await reset();
  ctl.mode = 'error';
  assert.equal(await mod.speakLine('Ciao.'), 'failed');
});

test('autoplay refused is reported FAILED, and not silently swallowed', async () => {
  await reset();
  ctl.mode = 'reject';
  assert.equal(await mod.speakLine('Ciao.'), 'failed');
});

test('a synthesis failure is reported FAILED', async () => {
  await reset();
  ctl.speakOk = false;
  assert.equal(await mod.speakLine('Ciao.'), 'failed');
});

test('BARGE-IN is reported CUT-SHORT — the one that must never read as played', async () => {
  await reset();
  ctl.mode = 'hang'; // playback has begun and will not finish on its own
  const p = mod.speakLine('Questa frase viene interrotta.');
  // Let the pump reach the clip, then do what a user clicking stop does.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctl.played, 1, 'the clip must have started before we cancel it');
  mod.interruptLocalVoice();
  const outcome = await p;
  assert.equal(outcome, 'cut-short', 'the user heard nothing: this must not be reported as played');
});

test('a cancel between the play and the first frame is CUT-SHORT too', async () => {
  await reset();
  ctl.mode = 'hang';
  const p = mod.speakLine('Ciao.');
  await new Promise((r) => setTimeout(r, 0));
  mod.interruptLocalVoice();
  assert.equal(await p, 'cut-short');
});

// ── a line is only played if every clip of it was ────────────────────────────

test('a line that plays one sentence and is then cut reports CUT-SHORT, not the last clip', async () => {
  // The aggregation trap: taking only the final clip's outcome would report this
  // line as played, because the last thing that happened to it was not the cut —
  // the cut is what has to survive into the answer.
  await reset();
  let n = 0;
  const realPlay = FakeAudio.prototype.play;
  FakeAudio.prototype.play = function patched() {
    n += 1;
    ctl.played += 1;
    if (n === 1) { queueMicrotask(() => this.fire('ended')); return Promise.resolve(); }
    return Promise.resolve(); // second clip hangs until cancelled
  };
  try {
    const p = mod.speakLine('Prima frase. Seconda frase.');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(ctl.played, 2, 'two sentences means two clips');
    mod.interruptLocalVoice();
    assert.equal(await p, 'cut-short', 'half a line is not a line');
  } finally {
    FakeAudio.prototype.play = realPlay;
  }
});

test('a line with nothing speakable in it is FAILED, and still answers', async () => {
  await reset();
  assert.equal(await mod.speakLine('   '), 'failed', 'an empty line must not resolve to played');
});

// ── the severity rule, stated rather than implied ───────────────────────────

test('a line is only played when nothing worse happened', () => {
  assert.equal(mod.worseOutcome('played', 'played'), 'played');
  assert.equal(mod.worseOutcome('played', 'cut-short'), 'cut-short');
  assert.equal(mod.worseOutcome('cut-short', 'played'), 'cut-short');
  assert.equal(mod.worseOutcome('cut-short', 'failed'), 'failed');
  assert.equal(mod.worseOutcome('failed', 'cut-short'), 'failed', 'a failure outranks a cut');
  assert.equal(mod.worseOutcome('played', 'failed'), 'failed');
});

test('the outcome type has three members, because the third is the point', () => {
  // A guard, not a tautology: `cut-short` is the value that gets collapsed into
  // `played` by someone tidying up a union type, and the human's rule is
  // violated the moment it disappears.
  const values = ['played', 'cut-short', 'failed'];
  for (const v of values) {
    assert.equal(mod.worseOutcome('played', v), v === 'played' ? 'played' : v,
      `${v} must be reachable and must not be reported as played`);
  }
});

// ── the announcer reports rather than assumes ───────────────────────────────

test('startTaskAnnouncer reports the outcome, including a cut one', async () => {
  await reset();
  const sent = [];
  globalThis.window.cth.onTaskDone = (cb) => {
    // Drive it the way main does: one event, then keep the subscription shape.
    setTimeout(() => cb({ taskId: 'task-1', kind: 'blocked', who: 'Jim', title: 'T', at: 0 }), 0);
    return () => { /* unsubscribe */ };
  };
  globalThis.window.cth.taskAnnouncementOutcome = (r) => { sent.push(r); };
  // Rebind the announcer module against the same globals, then start it.
  const ann = loadTs('src/renderer/src/realtime/announcer.ts');
  ctl.mode = 'hang';
  ann.startTaskAnnouncer();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ctl.played, 1, 'the sentence must actually have been queued for playback');
  mod.interruptLocalVoice();
  await new Promise((r) => setTimeout(r, 5));
  ann.stopTaskAnnouncer();
  delete globalThis.window.cth.onTaskDone;
  delete globalThis.window.cth.taskAnnouncementOutcome;
  assert.equal(sent.length, 1, 'exactly one ack per announcement');
  assert.equal(sent[0].outcome, 'cut-short',
    'a cut announcement must reach main as cut-short, or the floor cannot tell it from a delivered one');
  assert.equal(sent[0].taskId, 'task-1');
  assert.equal(sent[0].kind, 'blocked');
});
