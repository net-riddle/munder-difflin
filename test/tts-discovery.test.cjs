const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const D = loadTs(path.join(__dirname, '..', 'src', 'shared', 'ttsDiscovery.ts'));
const {
  KNOWN_TTS_MODELS,
  KNOWN_TTS_VOICES,
  languageLabel,
  voiceLang,
  parseModels,
  parseVoices,
  languagesOf,
  reconcileVoice,
  reconcileModel
} = D;

// The rule that made the fixed list wrong: the server is the authority on what
// it serves. These tests pin the SHAPE of that authority — what we accept from
// whatever a given server returns — because every failure mode here is a
// server answering in a shape nobody predicted.
//
// Every parser here degrades. None of them throws, because the caller is a
// Settings dropdown: an exception there takes down a modal over a cosmetic
// problem, and the free-text fallback is always a better answer than a crash.

test('languageLabel decodes Kokoro prefixes and passes unknown ones through', () => {
  assert.equal(languageLabel('af'), 'English (US)');
  assert.equal(languageLabel('am'), 'English (US)');
  assert.equal(languageLabel('bf'), 'English (UK)');
  assert.equal(languageLabel('im'), 'Italian');
  assert.equal(languageLabel('if'), 'Italian');
  assert.equal(languageLabel('zf'), 'Chinese');
  // Unknown prefixes are shown verbatim rather than guessed at: a wrong label
  // on a voice is worse than an honest code.
  assert.equal(languageLabel('xx'), 'XX');
  assert.equal(languageLabel(''), '?');
});

test('voiceLang reads the two-letter prefix and tolerates ids without one', () => {
  assert.equal(voiceLang('af_heart'), 'af');
  assert.equal(voiceLang('zf-xiaobei'), 'zf');
  assert.equal(voiceLang('alloy'), '');
  assert.equal(voiceLang(''), '');
  // Uppercase ids occur; the prefix must normalize so the filter groups them.
  assert.equal(voiceLang('AF_Heart'), 'af');
});

test('parseModels accepts the OpenAI envelope, a bare array, and bare strings', () => {
  assert.deepEqual(parseModels({ object: 'list', data: [{ id: 'tts-1' }, { id: 'kokoro' }] }), [
    'tts-1',
    'kokoro'
  ]);
  assert.deepEqual(parseModels(['a', 'b']), ['a', 'b']);
  // A server that names its models `name` instead of `id` still works.
  assert.deepEqual(parseModels({ data: [{ name: 'kokoro' }] }), ['kokoro']);
});

test('parseModels dedupes, so an id listed twice is not two picker rows', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'kokoro' }, { id: 'kokoro' }] }), ['kokoro']);
});

test('parseModels returns [] for anything unrecognized instead of throwing', () => {
  // This is the openedai-speech case: no /models at all, or an HTML 404 page.
  assert.deepEqual(parseModels(null), []);
  assert.deepEqual(parseModels(undefined), []);
  assert.deepEqual(parseModels('<html>404</html>'), []);
  assert.deepEqual(parseModels({ error: 'not found' }), []);
  assert.deepEqual(parseModels({ data: 'not an array' }), []);
});

test('parseVoices reads the real Kokoro shape, grade and prefix included', () => {
  const raw = [
    { id: 'af_alloy', name: 'Alloy', target_quality: 'B', overall_grade: 'C' },
    { id: 'af_heart', name: 'Heart', overall_grade: 'A' }
  ];
  assert.deepEqual(parseVoices({ voices: raw }), [
    { id: 'af_alloy', lang: 'af', grade: 'C' },
    { id: 'af_heart', lang: 'af', grade: 'A' }
  ]);
});

test('parseVoices keeps a server grade verbatim rather than mapping it to our scale', () => {
  // "A-" is the server's vocabulary. Reinterpreting it as a number is how a
  // picker ends up sorting voices by something the server never claimed.
  const [v] = parseVoices([{ id: 'af_heart', overall_grade: 'A-' }]);
  assert.equal(v.grade, 'A-');
});

test('parseVoices omits grade rather than inventing one', () => {
  // A server that grades nothing must produce no grade key, so the UI hides the
  // column instead of showing blanks for 72 rows.
  const [v] = parseVoices([{ id: 'af_heart' }]);
  assert.equal('grade' in v, false);
  assert.equal(v.lang, 'af');
});

test('parseVoices prefers an explicit language field over the id prefix', () => {
  const [v] = parseVoices([{ id: 'custom_01', language: 'IT' }]);
  assert.equal(v.lang, 'it');
});

test('parseVoices drops entries with no usable id', () => {
  const out = parseVoices([{ name: 'ok' }, {}, { id: '   ' }, { id: 'real' }]);
  assert.deepEqual(out.map((v) => v.id), ['ok', 'real']);
});

test('parseVoices returns [] when the server serves no voice list at all', () => {
  assert.deepEqual(parseVoices(null), []);
  assert.deepEqual(parseVoices({ data: null }), []);
  assert.deepEqual(parseVoices('not json'), []);
});

test('languagesOf is the sorted, deduped set the filter is built from', () => {
  const voices = parseVoices([
    { id: 'im_ricci' },
    { id: 'af_heart' },
    { id: 'af_bella' },
    { id: 'zf_xiaobei' }
  ]);
  assert.deepEqual(languagesOf(voices), ['af', 'im', 'zf']);
});

test('reconcileVoice never moves a user off a working voice', () => {
  // The load-bearing case: a server mid-restart answers with an empty or short
  // list, and the app must not silently reset a choice that was working.
  assert.equal(reconcileVoice('af_heart', parseVoices([{ id: 'af_bella' }])), 'af_heart');
  assert.equal(reconcileVoice('af_heart', []), 'af_heart');
});

test('reconcileVoice only fills a genuinely empty value', () => {
  assert.equal(reconcileVoice('', parseVoices([{ id: 'af_heart' }])), 'af_heart');
  assert.equal(reconcileVoice('   ', parseVoices([{ id: 'af_heart' }])), 'af_heart');
  // Nothing to fill from: returns empty rather than a hardcoded default, so the
  // caller decides whether the free-text path or a known id applies.
  assert.equal(reconcileVoice('', []), '');
});

test('reconcileModel behaves the same and falls back to a known id', () => {
  assert.equal(reconcileModel('kokoro', [{ id: 'tts-1' }]), 'kokoro');
  assert.equal(reconcileModel('', [{ id: 'tts-1' }]), 'tts-1');
  assert.equal(reconcileModel('', []), KNOWN_TTS_MODELS[0]);
});

test('the known ids are suggestions, and every one is a real id somewhere', () => {
  // Not a picker — a datalist. The test that matters is the negative one: the
  // list must not have grown into a closed set that a real server could fall
  // outside of, which is what the original TTS_MODELS constant was.
  assert.ok(KNOWN_TTS_MODELS.includes('tts-1'));
  assert.ok(KNOWN_TTS_MODELS.includes('kokoro'));
  assert.ok(KNOWN_TTS_VOICES.includes('alloy'));
  // A Kokoro voice id is deliberately absent — proof the list is not exhaustive.
  assert.equal(KNOWN_TTS_VOICES.includes('af_heart'), false);
});
