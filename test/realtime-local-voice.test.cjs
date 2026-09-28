'use strict';

// Realtime Michael — the 'local-tts' voice backend, unit-tested at its seams.
//
// The two pieces worth testing are pure, and both are places where being
// quietly wrong is expensive:
//
//   (a) splitSpeakableChunks — the voice queue speaks whatever this returns,
//       sentence by sentence, WHILE the model is still talking. A bug here is
//       audible twice over: dropped clauses (the answer's point is gone) and
//       early cuts (every sentence ends with a rising "chipmunk" intonation).
//       It is also the only place that knows a buffer is a STREAM, not a
//       string — the same text must split identically whether it arrives as one
//       delta or one character at a time.
//
//   (b) normalizeTtsBaseUrl — a hand-typed URL, and a wrong one silently means
//       "no voice at all" with no error the user can act on.
//
// (c) the settings normalizers: a config file from an older version has none
//     of these keys, and a bad one must degrade to a working default rather
//     than to a 400 from the TTS server.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  DEFAULT_LOCAL_TTS,
  clampTtsSpeed,
  normalizeTtsBaseUrl,
  normalizeTtsFormat,
  normalizeVoiceBackend,
  resolveLocalTtsSettings,
  speechUrl,
  splitSpeakableChunks,
  ttsMime
} = loadTs('src/shared/realtimeVoice.ts');

// ── (a) the streaming splitter ───────────────────────────────────────────────

/** Feed text one character at a time and return what the queue would speak. */
function streamDeltas(text) {
  const said = [];
  let buf = '';
  for (const ch of text) {
    const { chunks, rest } = splitSpeakableChunks(buf + ch, false);
    said.push(...chunks);
    buf = rest;
  }
  const { chunks } = splitSpeakableChunks(buf, true);
  said.push(...chunks);
  return said;
}

test('(a) a whole turn survives being streamed one character at a time', () => {
  const text = 'The floor is green. Creed is on a task. Nothing is blocked.';
  assert.deepEqual(streamDeltas(text).join(' '), text);
});

test('(a) a chunk is only spoken once its sentence is actually complete', () => {
  // The first delta ends mid-sentence. Speaking it would clip the first word
  // of the answer on every single turn.
  assert.deepEqual(splitSpeakableChunks('Let me check the').chunks, []);
  assert.deepEqual(splitSpeakableChunks('Let me check the floor').chunks, []);
  const cut = splitSpeakableChunks('Let me check the floor.');
  assert.deepEqual(cut.chunks, ['Let me check the floor.']);
  assert.equal(cut.rest, '');
});

test('(a) final:true flushes the tail that never reached a terminator', () => {
  // The common shape of a real answer: two sentences then a clause with no
  // full stop. Dropping that clause drops the point of the answer.
  const buf = 'Two things changed. The third one is still running';
  assert.deepEqual(splitSpeakableChunks(buf, false).chunks, ['Two things changed.']);
  assert.deepEqual(splitSpeakableChunks(buf, true).chunks, [
    'Two things changed.',
    'The third one is still running'
  ]);
});

test('(a) a fragment below the minimum length waits for the next delta', () => {
  // "OK." alone is a full sentence but a bad CLIP — a synthesis round-trip
  // for one word, and it sounds clipped. It waits and leaves with the next.
  const first = splitSpeakableChunks('OK.');
  assert.deepEqual(first.chunks, []);
  const second = splitSpeakableChunks(`${first.rest} Something else happened.`);
  assert.deepEqual(second.chunks, ['OK. Something else happened.']);
});

test('(a) abbreviations and initials do not end a sentence', () => {
  // Cutting after "Dr." turns "Dr. Foster is idle" into two clips, each with
  // a clipped falling tone. Same for "e.g." and single initials.
  assert.deepEqual(streamDeltas('Dr. Foster is idle.'), ['Dr. Foster is idle.']);
  assert.deepEqual(streamDeltas('Two tools failed, e.g. the floor read.'), [
    'Two tools failed, e.g. the floor read.'
  ]);
  assert.deepEqual(streamDeltas('Signed off by J. R. R. earlier.'), [
    'Signed off by J. R. R. earlier.'
  ]);
});

test('(a) quotes and brackets after the terminator stay with the sentence', () => {
  assert.deepEqual(splitSpeakableChunks('He said "ship it"', true).chunks, ['He said "ship it"']);
});

test('(a) a run without punctuation is broken instead of truncated', () => {
  // XTTS truncates at ~30s of audio. A wall of identifiers must be broken on
  // a clause boundary well before the cap, never cut at the cap mid-word.
  const wall = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ');
  const { chunks } = splitSpeakableChunks(wall, true);
  assert.ok(chunks.length > 1, 'expected more than one clip');
  assert.equal(chunks.join(' '), wall, 'no characters may be lost');
  for (const c of chunks) assert.ok(c.length <= 300, `clip too long: ${c.length}`);
});

test('(a) an oversized tail is released even without a terminator', () => {
  // Otherwise the first sentence of a long link dump would sit in the buffer
  // for the whole turn and the user would hear nothing at all.
  const text = 'word '.repeat(80);
  const { chunks, rest } = splitSpeakableChunks(text, false);
  assert.ok(chunks.length > 0, 'an oversized tail must not be held back');
  // Whatever is held is a SHORT tail, and streaming the rest still loses nothing.
  assert.ok(rest.length <= 240, `held tail too long: ${rest.length}`);
  const said = [...chunks, ...streamDeltas(rest)];
  assert.equal(said.join(' ').trim(), text.trim());
});

test('(a) a long run is broken on word boundaries, never mid-word', () => {
  const wall = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ');
  const { chunks } = splitSpeakableChunks(wall, true);
  for (const c of chunks) {
    // A piece ending mid-token would be pronounced as two words ("token1 2").
    assert.match(c, /token\d+$|^[a-z ]+$/i, `clip ends mid-token: ${JSON.stringify(c.slice(-20))}`);
  }
});

test('(a) whitespace-only and empty input are inert', () => {
  assert.deepEqual(splitSpeakableChunks('', false), { chunks: [], rest: '' });
  assert.deepEqual(splitSpeakableChunks('   \n ', false), { chunks: [], rest: ' ' });
  assert.deepEqual(splitSpeakableChunks('   \n ', true), { chunks: [], rest: '' });
});

// ── (b) the endpoint ─────────────────────────────────────────────────────────

test('(b) a bare host gains a scheme and the /v1 root', () => {
  assert.equal(normalizeTtsBaseUrl('localhost:8000'), 'http://localhost:8000/v1');
  assert.equal(normalizeTtsBaseUrl('  127.0.0.1:8000  '), 'http://127.0.0.1:8000/v1');
});

test('(b) trailing slashes and a missing /v1 both land on the same URL', () => {
  const want = 'http://localhost:8000/v1';
  assert.equal(normalizeTtsBaseUrl('http://localhost:8000/'), want);
  assert.equal(normalizeTtsBaseUrl('http://localhost:8000'), want);
  assert.equal(normalizeTtsBaseUrl('http://localhost:8000/v1'), want);
  assert.equal(normalizeTtsBaseUrl('http://localhost:8000/v1///'), want);
});

test('(b) a non-default port, path prefix and https survive', () => {
  assert.equal(
    normalizeTtsBaseUrl('https://tts.example.com:9000/api'),
    'https://tts.example.com:9000/api/v1'
  );
});

test('(b) a non-http scheme is refused rather than silently sent to', () => {
  // The whole security argument for doing this in main is that no request is
  // ever made to a host the user did not mean. file:// must not become a POST.
  assert.equal(normalizeTtsBaseUrl('file:///etc/passwd'), '');
  assert.equal(normalizeTtsBaseUrl('ftp://host/x'), '');
  assert.equal(normalizeTtsBaseUrl(''), '');
  assert.equal(normalizeTtsBaseUrl(undefined), '');
});

test('(b) the request URL is the OpenAI-compatible speech endpoint', () => {
  assert.equal(
    speechUrl('localhost:8000'),
    'http://localhost:8000/v1/audio/speech'
  );
});

// ── (c) settings normalization ───────────────────────────────────────────────

test('(c) a config from an older version fills every default', () => {
  assert.deepEqual(resolveLocalTtsSettings(undefined), DEFAULT_LOCAL_TTS);
  assert.deepEqual(resolveLocalTtsSettings({}), DEFAULT_LOCAL_TTS);
});

test('(c) junk values degrade to something that works', () => {
  // Every one of these used to be able to reach the TTS server verbatim and
  // come back as a 400 the user could not act on.
  assert.deepEqual(
    resolveLocalTtsSettings({
      baseUrl: 'not a url at all',
      model: '   ',
      voice: '',
      speed: 'fast',
      format: 'aiff'
    }),
    { ...DEFAULT_LOCAL_TTS, baseUrl: DEFAULT_LOCAL_TTS.baseUrl }
  );
});

test('(c) speed is clamped into the documented window', () => {
  assert.equal(clampTtsSpeed(0.01), 0.25);
  assert.equal(clampTtsSpeed(99), 4);
  assert.equal(clampTtsSpeed(1.256), 1.26);
  assert.equal(clampTtsSpeed(0), DEFAULT_LOCAL_TTS.speed);
  assert.equal(clampTtsSpeed(-3), DEFAULT_LOCAL_TTS.speed);
});

test('(c) an unknown backend falls back to the shipped voice', () => {
  // Silently choosing a backend the user did not pick is worse than the
  // default: they would hear a different voice with no explanation.
  assert.equal(normalizeVoiceBackend('local-tts'), 'local-tts');
  assert.equal(normalizeVoiceBackend('openai'), 'openai');
  assert.equal(normalizeVoiceBackend('nonsense'), 'openai');
  assert.equal(normalizeVoiceBackend(undefined), 'openai');
});

test('(c) mp3 is the default format, and every format has a mime', () => {
  assert.equal(normalizeTtsFormat(undefined), 'mp3');
  assert.equal(normalizeTtsFormat('wav'), 'wav');
  assert.equal(ttsMime('mp3'), 'audio/mpeg');
  assert.ok(ttsMime('wav').startsWith('audio/'));
});
