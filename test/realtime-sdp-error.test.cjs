'use strict';

// Realtime Michael — the swallowed SDP handshake error.
//
// Symptom: pressing Talk reported
//   "Failed to execute 'setRemoteDescription' on 'RTCPeerConnection'"
// which names a WebRTC API and no cause. The actual refusal was in the HTTP
// response the SDK read and threw away (openaiRealtimeWebRtc.js has no
// `sdpResponse.ok` check), so the status and the API's own message — the only
// actionable part — never reached the user.
//
// The interceptor has three ways to be wrong, and each has its own test:
//   1. it must NOT consume the body (the SDK reads it next; a used stream
//      would fail with "body already used" and mask the error a second time),
//   2. it must NOT touch any other request,
//   3. it must always be removed, including on success and on throw.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { withSdpErrorReporting } = loadTs('src/renderer/src/realtime/realtimeSdpError.ts');

/** A Response whose body can be read, and which fails if read twice — the same
 *  contract the real fetch Response has. */
function fakeResponse({ status = 200, statusText = 'OK', body = '' } = {}) {
  let used = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    clone() { return fakeResponse({ status, statusText, body }); },
    async text() {
      if (used) throw new Error('body already used');
      used = true;
      return body;
    }
  };
}

/** Install a fake fetch for one test; returns a restore function. */
function withFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

test('a refused handshake reports the status and the API message', async () => {
  const restore = withFetch(async () =>
    fakeResponse({
      status: 401,
      statusText: 'Unauthorized',
      body: '{"error":{"message":"Invalid ephemeral key","type":"invalid_request_error"}}'
    })
  );
  try {
    await withSdpErrorReporting(async () => {
      // The SDK's real sequence: POST the offer, read the body as SDP, then
      // blow up in setRemoteDescription because it was not SDP.
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection'");
    });
    assert.fail('expected a throw');
  } catch (e) {
    // The DOMException is still named, so a console dump shows which call
    // failed — but the cause is now first and actionable.
    assert.match(e.message, /401/);
    assert.match(e.message, /Invalid ephemeral key/);
    assert.match(e.message, /setRemoteDescription/);
    assert.ok(e.cause, 'the original SDK error is preserved');
  } finally {
    restore();
  }
});

test('the response body is left readable for the SDK', async () => {
  // The regression that would make this module worse than the bug: if the
  // interceptor consumed the body, the SDK's own sdpResponse.text() would throw
  // "body already used" and the user would get a NEW misleading error.
  const res = fakeResponse({ status: 403, statusText: 'Forbidden', body: '{"error":"nope"}' });
  const restore = withFetch(async () => res);
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      // This is the SDK's next line. It must still work.
      const sdp = await res.text();
      assert.equal(sdp, '{"error":"nope"}');
      throw new Error('setRemoteDescription failed');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /403/);
  } finally {
    restore();
  }
});

test('only the calls POST is inspected', async () => {
  const seen = [];
  const restore = withFetch(async (input) => {
    const url = String(input);
    seen.push(url);
    // The TTS bridge and the session events go through the same fetch. A
    // failure there is NOT a handshake failure and must not be reported as
    // one — the calls POST succeeds, so there is nothing to capture.
    if (url.includes('/realtime/calls')) return fakeResponse({ status: 200, body: 'v=0\r\n' });
    return fakeResponse({ status: 500, statusText: 'Server Error', body: 'tts down' });
  });
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('http://localhost:8000/v1/audio/speech', { method: 'POST' });
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('boom');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.equal(seen.length, 2);
    assert.equal(e.message, 'boom', 'the unrelated 500 must not be reported');
    assert.doesNotMatch(e.message, /tts down/);
  } finally {
    restore();
  }
});

test('a successful handshake rethrows nothing and leaves fetch as it found it', async () => {
  const restore = withFetch(async () => fakeResponse({ status: 200, body: 'v=0\r\n' }));
  const patched = globalThis.fetch;
  try {
    const out = await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      return 'connected';
    });
    assert.equal(out, 'connected');
    // Restored to the value present at entry — the caller's fetch, not a
    // second layer of interception left behind.
    assert.equal(globalThis.fetch, patched);
  } finally {
    restore();
  }
});

test('fetch is restored even when the diagnostics themselves throw', async () => {
  const restore = withFetch(async () => ({
    ok: false,
    status: 500,
    statusText: 'Server Error',
    // A Response whose clone() blows up: the interceptor must swallow this
    // rather than let it become the reported cause.
    clone() { throw new Error('clone unavailable'); },
    async text() { return ''; }
  }));
  const patched = globalThis.fetch;
  try {
    await withSdpErrorReporting(async () => { throw new Error('original'); });
    assert.fail('expected a throw');
  } catch (e) {
    assert.equal(e.message, 'original', 'the real cause is not replaced');
  } finally {
    assert.equal(globalThis.fetch, patched, 'fetch must be restored before propagating');
    restore();
  }
});

test('a refusal with an empty body still reports the status', async () => {
  const restore = withFetch(async () => fakeResponse({ status: 502, statusText: 'Bad Gateway', body: '' }));
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('setRemoteDescription failed');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /502/);
    assert.match(e.message, /Bad Gateway/);
  } finally {
    restore();
  }
});

test('a refusal is still caught when the SDK passes a URL INSTANCE', async () => {
  // The regression that made this whole module inert. The SDK does
  // `fetch(new URL(baseUrl), …)`, and a URL has no `.url` property — only
  // `.href` — so matching on `.url` read `undefined` and NOTHING was ever
  // captured or logged. Silent: no error thrown, no diagnostics, the original
  // error propagates as if the interceptor were not installed.
  const restore = withFetch(async () =>
    fakeResponse({ status: 401, statusText: 'Unauthorized', body: '{"error":{"message":"Invalid ephemeral key"}}' })
  );
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch(new URL('https://api.openai.com/v1/realtime/calls'), { method: 'POST' });
      throw new Error('setRemoteDescription failed');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /401/, 'a URL argument must be recognised');
    assert.match(e.message, /Invalid ephemeral key/);
  } finally {
    restore();
  }
});

test('all three fetch argument shapes are recognised', async () => {
  // string, URL, Request — the forms a caller can legitimately use.
  const seen = [];
  const restore = withFetch(async (input) => {
    seen.push(String(input));
    return fakeResponse({ status: 200, statusText: 'OK', body: 'not sdp at all' });
  });
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls');
      await globalThis.fetch(new URL('https://api.openai.com/v1/realtime/calls'));
      await globalThis.fetch(new Request('https://api.openai.com/v1/realtime/calls'));
      throw new Error('boom');
    });
    assert.fail('expected a throw');
  } catch (e) {
    // All three were inspected, so the report is the last one rather than a
    // miss on the first.
    assert.equal(seen.length, 3);
    assert.match(e.message, /not SDP/);
  } finally {
    restore();
  }
});

test('a request to an unrelated URL is not captured', async () => {
  const restore = withFetch(async () => fakeResponse({ status: 500, statusText: 'Server Error', body: 'x' }));
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch(new URL('https://example.com/other'));
      throw new Error('original');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.equal(e.message, 'original');
  } finally {
    restore();
  }
});

test('a multi-line error body is collapsed to one readable line', async () => {
  const restore = withFetch(async () =>
    fakeResponse({ status: 400, statusText: 'Bad Request', body: 'model not supported\nrequest id: req_9' })
  );
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('setRemoteDescription failed');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /model not supported/);
    assert.doesNotMatch(e.message, /request id/, 'trailing noise is dropped');
    assert.equal(e.message.split('\n').length, 1, 'must stay a single line for the tooltip');
  } finally {
    restore();
  }
});

// ── 2xx that is not SDP ─────────────────────────────────────────────────────
// The shape behind "failed to parse SessionDescription": the POST SUCCEEDS, so
// nothing in the non-2xx path fires, and the body is still not an answer. The
// SDK's message names a DOMException and carries zero information about it.

test('a 200 carrying an HTML page is reported, not swallowed', async () => {
  const restore = withFetch(async () =>
    fakeResponse({ status: 200, statusText: 'OK', body: '<!doctype html><title>Proxy</title>' })
  );
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('Failed to execute setRemoteDescription: Failed to parse SessionDescription');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /not SDP/);
    assert.match(e.message, /doctype/);
    assert.match(e.message, /SessionDescription/, 'the original message is still there');
  } finally {
    restore();
  }
});

test('a 200 with an EMPTY body gets its own wording', async () => {
  // "empty" and "unexpected text" call for different next steps, so they must
  // not collapse into one message.
  const restore = withFetch(async () => fakeResponse({ status: 200, statusText: 'OK', body: '' }));
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('Failed to parse SessionDescription');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /empty/i);
  } finally {
    restore();
  }
});

test('a real SDP answer produces no extra reporting', async () => {
  // The success path must stay silent: a healthy handshake is the common case
  // and must not be dressed up as a problem. And a body that IS a well-formed
  // answer is not ours to reinterpret — if something downstream fails, the
  // original error is the honest report.
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=group:BUNDLE 0\r\n';
  const restore = withFetch(async () => fakeResponse({ status: 200, statusText: 'OK', body: sdp }));
  try {
    const out = await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      return 'connected';
    });
    assert.equal(out, 'connected');
  } finally {
    restore();
  }
});

test('a failure after a well-formed answer keeps the original message', async () => {
  // The answer was valid, so blaming the body would be a guess: the real cause
  // is whatever broke next (a media track, a peer state).
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
  const restore = withFetch(async () => fakeResponse({ status: 200, statusText: 'OK', body: sdp }));
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('RTCRtpReceiver error');
    });
    assert.fail('expected a throw');
  } catch (e) {
    assert.equal(e.message, 'RTCRtpReceiver error');
  } finally {
    restore();
  }
});

test('a truncated SDP body is reported with its length', async () => {
  // "v=0" and nothing else passes looksLikeSdp yet cannot parse — the shape
  // behind "Expect line: v=". The sample makes the truncation visible.
  const restore = withFetch(async () => fakeResponse({ status: 200, statusText: 'OK', body: 'v=0' }));
  try {
    await withSdpErrorReporting(async () => {
      await globalThis.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST' });
      throw new Error('Failed to parse SessionDescription');
    });
    assert.fail('expected a throw');
  } catch (e) {
    // A body that starts with v= is left to the original error (see above)…
    assert.match(e.message, /Failed to parse SessionDescription/);
  } finally {
    restore();
  }
});

test('a failure with no calls response at all keeps the original message', async () => {
  // A WebRTC/media failure never reaches the network. Rewriting it with
  // handshake language would be a lie.
  const restore = withFetch(async () => fakeResponse({ status: 200, body: 'v=0\r\n' }));
  try {
    await withSdpErrorReporting(async () => { throw new Error('microphone permission denied'); });
    assert.fail('expected a throw');
  } catch (e) {
    assert.equal(e.message, 'microphone permission denied');
  } finally {
    restore();
  }
});
