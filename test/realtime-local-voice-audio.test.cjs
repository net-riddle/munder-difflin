'use strict';

// The local voice queue's handling of the AUDIO it receives: decoding,
// playback, and — the part that leaks if it is wrong — releasing it.
//
// The queue holds three resources per clip: the base64 string from the bridge,
// the decoded bytes, and the object URL the media element plays from. All three
// must be released, and a clip that cannot be decoded must not take the rest of
// the queue with it. Both failures are silent — the user just hears nothing,
// forever, with no error anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

/** A minimal media environment that records what was created and released. */
function installEnv({ speak } = {}) {
  const created = [];
  const revoked = [];
  let playing = [];

  globalThis.window = {
    cth: {
      realtimeSpeak: async ({ text }) =>
        speak ? speak(text) : { ok: true, audio: Buffer.from(text).toString('base64'), mime: 'audio/mpeg', bytes: 1 },
      realtimeLogError: async () => ({ ok: true })
    }
  };
  globalThis.URL = {
    createObjectURL: (blob) => { const u = `blob:${created.length}`; created.push({ u, blob }); return u; },
    revokeObjectURL: (u) => revoked.push(u)
  };
  globalThis.Blob = class { constructor(parts) { this.parts = parts; this.type = arguments[1]?.type; } };

  // A play() that ends only when told to, so playback is controllable.
  globalThis.Audio = class {
    constructor() { this.listeners = {}; this.paused = false; playing.push(this); }
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
    removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter((f) => f !== fn); }
    fire(k) { for (const fn of [...(this.listeners[k] || [])]) fn(); }
    set src(v) { this._src = v; }
    get src() { return this._src; }
    play() { this.playing = true; return Promise.resolve(); }
    pause() { this.paused = true; this.playing = false; }
    removeAttribute() { this._src = null; }
    setSinkId() { return Promise.resolve(); }
  };

  return { created, revoked, sink: () => playing[playing.length - 1] };
}

const voice = () => loadTs('src/renderer/src/realtime/localVoice.ts');

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.Audio;
});

// ── releasing the audio ─────────────────────────────────────────────────────

test('a clip is released exactly once, as soon as it finishes', async () => {
  const env = installEnv();
  const v = voice();
  v.speakLine('One sentence.');
  // Let the synthesis promise and the clip start resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(env.created.length, 1, 'one clip was created');

  env.sink().fire('ended');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(env.revoked, ['blob:0'], 'the object URL is released when the clip ends');
  v.stopLocalVoice();
});

test('every clip in a multi-sentence line is released, none held to teardown', async () => {
  const env = installEnv();
  const v = voice();
  // Long enough that the splitter keeps each sentence as its own clip: short
  // ones are held back and merged with the next, which is the documented
  // behaviour and covered in realtime-local-voice.test.cjs.
  v.speakLine('The first sentence is long enough to stand alone. The second one is too. And so is the third.');
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setImmediate(r));
    if (env.sink()?.playing) env.sink().fire('ended');
  }
  assert.equal(env.created.length, 3, 'three sentences became three clips');
  // The point of the bug this guards: holding URLs until disconnect pins every
  // clip's bytes for the whole session, which is tens of megabytes.
  assert.equal(env.revoked.length, 3, 'all three released as they played');
  assert.deepEqual(env.revoked.sort(), ['blob:0', 'blob:1', 'blob:2']);
  v.stopLocalVoice();
});

test('a clip cut short is still released', async () => {
  const env = installEnv();
  const v = voice();
  v.speakLine('Something long enough to be interrupted.');
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.equal(env.created.length, 1);

  v.interruptLocalVoice();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(env.revoked, ['blob:0'], 'interrupting must not leak the object URL');
  assert.equal(env.sink().paused, true, 'and must stop playback');
  v.stopLocalVoice();
});

// ── a clip that cannot be decoded must not wedge the queue ──────────────────

test('an undecodable clip does not kill the queue', async () => {
  // The regression. The decode failure handler calls the same `done()` the
  // normal path uses, and that path clears a timer that is declared AFTER it —
  // so the handler itself threw a ReferenceError, the promise never settled,
  // `pumping` stayed true, and every later speakLine() was a silent no-op. One
  // malformed payload from the bridge bricked the voice until restart.
  const env = installEnv({
    speak: (text) => (text.includes('BROKEN')
      ? { ok: true, audio: 'not-valid-base64-%%%', mime: 'audio/mpeg', bytes: 3 }
      : { ok: true, audio: Buffer.from(text).toString('base64'), mime: 'audio/mpeg', bytes: 1 })
  });
  const v = voice();

  v.speakLine('BROKEN first.');
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

  // The good line after it must still be synthesized and played.
  v.speakLine('A good one.');
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setImmediate(r));
    if (env.sink()?.playing) env.sink().fire('ended');
  }

  assert.equal(env.created.length, 1, 'only the good clip produced audio');
  assert.ok(
    env.created[0].blob.parts[0].length > 0,
    'the queue kept going after the bad clip'
  );
  v.stopLocalVoice();
});

test('a failed synthesis is logged and the queue continues', async () => {
  const logged = [];
  globalThis.window = {
    cth: {
      realtimeSpeak: async ({ text }) =>
        text.includes('FAIL')
          ? { ok: false, error: 'TTS server down', code: 'network' }
          : { ok: true, audio: Buffer.from(text).toString('base64'), mime: 'audio/mpeg', bytes: 1 },
      realtimeLogError: async (_w, m) => { logged.push(m); return { ok: true }; }
    }
  };
  const env = installEnv();
  globalThis.window.cth = {
    realtimeSpeak: async ({ text }) =>
      text.includes('FAIL')
        ? { ok: false, error: 'TTS server down', code: 'network' }
        : { ok: true, audio: Buffer.from(text).toString('base64'), mime: 'audio/mpeg', bytes: 1 },
    realtimeLogError: async (_w, m) => { logged.push(m); return { ok: true }; }
  };

  const v = voice();
  v.speakLine('FAIL this one.');
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(logged, ['TTS server down'], 'a dead TTS server is recorded, not swallowed');

  v.speakLine('And this one works.');
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setImmediate(r));
    if (env.sink()?.playing) env.sink().fire('ended');
  }
  assert.equal(env.created.length, 1, 'the queue survived the failure');
  v.stopLocalVoice();
});

test('the sink is created lazily, so the announcer works with no session', async () => {
  // No startLocalVoice() call: the task-done announcer has no session to arm
  // one. Without lazy creation the clip is skipped and the announcement is
  // silently lost, which looks exactly like a broken TTS server.
  const env = installEnv();
  const v = voice();
  v.speakLine('Nobody armed me.');
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setImmediate(r));
    if (env.sink()?.playing) env.sink().fire('ended');
  }
  assert.equal(env.created.length, 1);
  v.stopLocalVoice();
});
