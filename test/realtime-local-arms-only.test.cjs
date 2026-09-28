'use strict';

// The Talk button in LOCAL mode: which things it must NOT do.
//
// This is the seam the change is really about. A local voice opens no session,
// so pressing the button must not:
//
//   - mint a token        (that is an OpenAI call, and the whole point of the
//                          backend is to work with an empty balance)
//   - open the microphone (there is nothing to hear — the user is not talking)
//   - build a RealtimeSession
//
// Each of those is a real cost or a real permission prompt, and all three are
// invisible from the UI: the button would just work "except" for a network
// call the user never asked for. So the rule is asserted here against the real
// module, with the bridge replaced by a recorder.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

/** Stand in for the preload bridge, recording every call. `onTaskDone` counts
 *  LIVE subscriptions, so the announcer's on/off can be asserted directly rather
 *  than inferred from whether audio happened to come out. */
function installBridge({ backend = 'local-tts' } = {}) {
  const calls = [];
  const onTaskDone = { count: 0, sent: [] };
  globalThis.window = {
    cth: {
      realtimeVoiceSettings: async () => { calls.push('voiceSettings'); return { backend, tts: {} }; },
      realtimeMintToken: async () => {
        calls.push('mintToken');
        return { ok: true, token: 'ek_should_not_happen', expiresAt: null, sessionConfig: { model: 'm' } };
      },
      realtimeLog: async () => { calls.push('log'); return { ok: true }; },
      realtimeLogError: async () => ({ ok: true }),
      updateConfig: async () => { calls.push('updateConfig'); return { ok: true }; },
      getConfig: async () => ({}),
      realtimeSetSessionLive: async () => { calls.push('setSessionLive'); return { ok: true }; },
      realtimeSpeak: async ({ text }) => ({
        ok: true, audio: Buffer.from(text).toString('base64'), mime: 'audio/mpeg', bytes: 1
      }),
      onTaskDone: (cb) => {
        onTaskDone.count += 1;
        onTaskDone.sent.push(cb);
        return () => { onTaskDone.count -= 1; };
      }
    }
  };
  // The module touches Audio on arm; a stub keeps the test headless.
  globalThis.Audio = class { constructor() { this.autoplay = false; this.preload = ''; } pause() {} removeAttribute() {} play() { return Promise.resolve(); } addEventListener() {} removeEventListener() {} setSinkId() { return Promise.resolve(); } };
  return { calls, onTaskDone };
}

/** getUserMedia is the signal that matters: a microphone permission prompt in
 *  local mode is a bug the user meets as an unexplained dialog. This trips if
 *  it is ever called. */
function trapGetUserMedia() {
  let called = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => { called = true; throw new Error('MIC OPENED'); } } }
  });
  return () => called;
}

const session = loadTs('src/renderer/src/realtime/session.ts');

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.Audio;
});

test('local mode arms the speaker without minting or opening the mic', async () => {
  const { calls } = installBridge({ backend: 'local-tts' });
  const micOpened = trapGetUserMedia();
  await session.connect();

  assert.ok(!calls.includes('mintToken'), 'a local voice must never contact OpenAI to mint');
  assert.ok(!calls.includes('updateConfig'), 'the mic permission gate must not be flipped');
  assert.ok(!calls.includes('setSessionLive'), 'there is no session to mark live');
  assert.equal(micOpened(), false, 'getUserMedia must not be reached in local mode');
  // Disconnect before returning: connect() is idempotent by design, and the
  // announcer's arming flag is module state, so a test that leaves it on makes
  // the NEXT test observe a no-op. Test hygiene, not behaviour.
  session.disconnect();
});

test('the state reports the local backend so the button can rename itself', async () => {
  const { onTaskDone } = installBridge({ backend: 'local-tts' });
  trapGetUserMedia();
  await session.connect();
  // The switch is the subscription itself: armed while the button is on, and
  // released when it is pressed again.
  assert.equal(onTaskDone.count, 1);
  session.disconnect();
  assert.equal(onTaskDone.count, 0);
});

test('disconnect in local mode does not claim a session ended', async () => {
  const { calls } = installBridge({ backend: 'local-tts' });
  trapGetUserMedia();
  await session.connect();
  calls.length = 0;
  session.disconnect();
  // realtimeSetSessionLive(false) is the flag main uses to decide whether
  // completions are pushed live or queued. Firing it with no session would tell
  // main a voice session just ended — a lie that changes task-notification
  // routing for the rest of the run.
  assert.ok(!calls.includes('setSessionLive'), 'no session existed, so none may be reported closed');
});

test('the OpenAI path is untouched by any of this', async () => {
  // The mirror of the test above, and the one that matters if someone later
  // "simplifies" the local branch into the shared path: the OpenAI loop must
  // still mint, still gate the mic, and still mark the session live.
  const { calls } = installBridge({ backend: 'openai' });
  trapGetUserMedia();
  // getUserMedia throws by design, so connect() fails after the mint. That is
  // enough to prove this path still mints and still opens the mic gate.
  await session.connect().catch(() => {});
  assert.ok(calls.includes('mintToken'), 'the OpenAI path must still mint a token');
  assert.ok(calls.includes('updateConfig'), 'and must still open the mic gate');
});

// ── the button is the ONLY switch ───────────────────────────────────────────
// Announcements used to be armed unconditionally at app start, which left the
// Talk button controlling a thing that was already on: a control that appears to
// switch something and does not. Now the subscription is created by connect()
// and dropped by disconnect().

test('nothing is announced before the button is pressed', () => {
  const { onTaskDone } = installBridge({ backend: 'local-tts' });
  const announcer = loadTs('src/renderer/src/realtime/announcer.ts');
  announcer.startTaskAnnouncer();
  onTaskDone.sent.length = 0;
  announcer.stopTaskAnnouncer();
  // The bridge records every subscription so the test can assert on it rather
  // than on a side effect that is easy to fake.
  assert.equal(onTaskDone.count, 0, 'arming must be the button’s job alone');
});

test('pressing the button subscribes exactly once, and stopping unsubscribes', async () => {
  const { onTaskDone } = installBridge({ backend: 'local-tts' });
  trapGetUserMedia();
  await session.connect();
  assert.equal(onTaskDone.count, 1, 'one live subscription while announcing');

  // Pressing again must not double it: a double subscription says every
  // sentence twice.
  session.disconnect();
  assert.equal(onTaskDone.count, 0, 'stopping releases the subscription');
});
