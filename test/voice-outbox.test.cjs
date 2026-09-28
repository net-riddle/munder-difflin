'use strict';

// The spoken-message bridge: the parts that are pure logic.
//
// The failure this guards is AUDIBLE, not visible. A message containing a file
// path, a markdown bullet or a 900-character paragraph looks perfectly fine in
// an editor and is unusable through a speaker — so nothing else would ever
// report it. Each rule below corresponds to a way that has actually failed.
//
// The playback and synthesis paths are Windows/OS specific and are not exercised
// here; what is tested is the decision layer, which is where the judgement
// lives and which is the part a reviewer needs to trust.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', 'resources', 'skills', 'md-voice-brief', 'voice-outbox.mjs')
).href;

let mod;
test.before(async () => { mod = await import(MODULE); });

// ─── the checker ─────────────────────────────────────────────────────────────

test('a plain sentence passes', () => {
  const r = mod.checkSpokenText('The reservation fix is deployed and verified.');
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test('a file path is rejected, with the path quoted back', () => {
  // The single most common case: an agent reporting what it changed. The path
  // is unreadable aloud, so the finding names it — the author needs to know
  // WHICH one, not just that one exists.
  const r = mod.checkSpokenText('I fixed the bug in src/api/Reservation.ts.');
  assert.equal(r.ok, false);
  const p = r.blocking.find((f) => f.code === 'path');
  assert.ok(p, 'expected a path finding');
  assert.match(p.detail, /src\/api\/Reservation\.ts/);
});

test('a Windows path is caught too', () => {
  const r = mod.checkSpokenText('The change is in src\\main\\realtime.ts now.');
  assert.equal(r.ok, false);
  assert.ok(r.blocking.some((f) => f.code === 'path'));
});

test('URLs, markdown and emoji are all rejected', () => {
  const cases = [
    ['See https://github.com/a/b/pull/42 for details.', 'url'],
    ['**Done** — the build is green.', 'bold'],
    ['I used `npm test` to verify.', 'code'],
    ['## Summary', 'heading'],
    ['- first thing\n- second thing', 'bullet'],
    ['| a | b |\n| --- | --- |', 'table'],
    ['All green 🎉', 'emoji'],
    ['**bold** and `code`', 'bold']
  ];
  for (const [text, code] of cases) {
    const r = mod.checkSpokenText(text);
    assert.ok(
      r.blocking.some((f) => f.code === code),
      `expected [${code}] for: ${JSON.stringify(text)} (got ${r.blocking.map((f) => f.code)})`
    );
  }
});

test('screen-only markers are rejected', () => {
  for (const text of ['TODO: finish this', 'FIXME later', 'a 40-char commit hash abc1234']) {
    const r = mod.checkSpokenText(text);
    assert.equal(r.ok, false, `expected a rejection for: ${text}`);
  }
});

test('length: over the cap blocks, under the warn threshold does not', () => {
  const long = 'word '.repeat(Math.ceil(mod.MAX_SPOKEN_CHARS / 5) + 10);
  const over = mod.checkSpokenText(long);
  assert.equal(over.ok, false);
  assert.ok(over.blocking.some((f) => f.code === 'too-long'));

  // Between the warn and the cap: allowed, but the author is told.
  const mid = 'word '.repeat(Math.ceil(mod.WARN_SPOKEN_CHARS / 5) + 4);
  const warned = mod.checkSpokenText(mid);
  assert.equal(warned.ok, true, 'must not block');
  assert.ok(warned.findings.some((f) => f.code === 'long'), 'but should warn');
});

test('whitespace findings never block, because fixing them cannot change meaning', () => {
  // Blank lines are read as silence and trailing space is nothing, but neither
  // is a reason to refuse a message the author already wrote correctly.
  const r = mod.checkSpokenText('  The deploy finished.  \n\n  Nothing else to report.  ');
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes('edge-space') || codes.includes('blank-lines'));
  assert.equal(r.blocking.length, 0);
  assert.equal(r.ok, true, 'whitespace alone must not block');
});

test('empty text is rejected, not queued', () => {
  // An empty envelope is a TTS call with no text: the server either errors or
  // says nothing, and the user cannot tell which happened.
  for (const t of ['', '   ', '\n\n']) {
    assert.equal(mod.checkSpokenText(t).ok, false, JSON.stringify(t));
  }
});

test('an ellipsis is flagged: a voice renders it as an unknown-length pause', () => {
  const r = mod.checkSpokenText('Well... it worked, in the end.');
  assert.ok(r.findings.some((f) => f.code === 'ellipsis'));
});

test('nested parentheses are flagged, single ones are not', () => {
  assert.ok(mod.checkSpokenText('It failed (see the log at line 42).').ok);
  assert.equal(mod.checkSpokenText('It failed (see the log (line 42)).').ok, false);
});

// ─── normalization: the one thing that IS fixed for the author ───────────────

test('normalize collapses whitespace and nothing else', () => {
  // Deliberately not a markdown stripper: mechanically removing markers leaves
  // broken sentences, which are worse than the marker.
  assert.equal(mod.normalizeSpoken('  a\n\nb   c  '), 'a b c');
  assert.equal(mod.normalizeSpoken('**keep** this'), '**keep** this');
  assert.equal(mod.normalizeSpoken('a/b.ts'), 'a/b.ts');
});

// ─── envelopes ───────────────────────────────────────────────────────────────

test('a well-formed envelope validates', () => {
  const r = mod.validateEnvelope({ v: 1, id: 'msg-1', text: 'Deploy finished.' });
  assert.equal(r.ok, true);
});

test('a future version, a bad shape and an empty text are all refused', () => {
  assert.equal(mod.validateEnvelope({ v: 2, text: 'x' }).ok, false, 'unknown version');
  assert.equal(mod.validateEnvelope({ v: 1 }).ok, false, 'no text');
  assert.equal(mod.validateEnvelope({ v: 1, text: '   ' }).ok, false, 'blank text');
  assert.equal(mod.validateEnvelope({ v: 1, text: 'x', voice: 7 }).ok, false, 'non-string voice');
  assert.equal(mod.validateEnvelope(null).ok, false);
  assert.equal(mod.validateEnvelope([]).ok, false);
});

test('an over-long envelope is refused with the count in the message', () => {
  const r = mod.validateEnvelope({ v: 1, text: 'x'.repeat(mod.MAX_SPOKEN_CHARS + 1) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), new RegExp(String(mod.MAX_SPOKEN_CHARS)));
});

// ─── config: the voice must match what the user chose in Settings ─────────────

test('TTS settings come from the app config, not from the script', () => {
  // This is the whole reason the script reads config.json: a message spoken by
  // an agent has to sound like Michael, not like a different machine.
  const s = mod.resolveTtsSettings({
    realtimeTtsBaseUrl: 'http://10.0.0.5:9000/v1',
    realtimeTtsModel: 'tts-1-hd',
    realtimeTtsVoice: 'nova',
    realtimeTtsSpeed: 1.25
  });
  assert.equal(s.baseUrl, 'http://10.0.0.5:9000/v1');
  assert.equal(s.model, 'tts-1-hd');
  assert.equal(s.voice, 'nova');
  assert.equal(s.speed, 1.25);
  assert.equal(s.format, 'wav', 'winsound plays PCM WAV with no codec');
});

test('a missing or junk config falls back to the app defaults', () => {
  for (const c of [undefined, null, {}, { realtimeTtsVoice: '' }]) {
    const s = mod.resolveTtsSettings(c);
    assert.equal(s.baseUrl, 'http://localhost:8000/v1');
    assert.equal(s.voice, 'alloy');
    assert.equal(s.speed, 1);
  }
});

test('a per-message voice overrides the configured one', () => {
  const s = mod.resolveTtsSettings({ realtimeTtsVoice: 'alloy' }, { voice: 'shimmer' });
  assert.equal(s.voice, 'shimmer');
});

test('the backend decides which route the author should use', () => {
  assert.equal(mod.resolveTtsSettings({ realtimeVoiceBackend: 'local-tts' }).backend, 'local-tts');
  assert.equal(mod.resolveTtsSettings({ realtimeVoiceBackend: 'openai' }).backend, 'openai');
  // A fresh install has no key, so the default must be the CLOUD route — the
  // one where the script must stay silent.
  assert.equal(mod.resolveTtsSettings({}).backend, 'openai');
});

// ─── paths ───────────────────────────────────────────────────────────────────

test('userData resolves per platform and honours the override', () => {
  // Compared by SEGMENTS, not by a `/`-delimited regex: `homedir()` returns a
  // NATIVE path, so on Windows the darwin case legitimately contains backslashes
  // and a forward-slash pattern cannot match it.
  const seg = (p) => p.split(/[\\/]/).filter(Boolean);

  assert.deepEqual(seg(mod.resolveUserData({ APPDATA: 'C:\\Roaming' }, 'win32')), [
    'C:', 'Roaming', 'munder-difflin'
  ]);
  assert.deepEqual(seg(mod.resolveUserData({}, 'darwin')).slice(-3), [
    'Library', 'Application Support', 'munder-difflin'
  ]);
  assert.deepEqual(seg(mod.resolveUserData({ XDG_CONFIG_HOME: '/tmp/cfg' }, 'linux')).slice(-2), [
    'cfg', 'munder-difflin'
  ]);
  assert.equal(mod.resolveUserData({ MD_USER_DATA: '/somewhere' }, 'linux'), path.resolve('/somewhere'));
});

test('importing the module does not speak anything', () => {
  // The helpers are unit-tested, so the module is imported. If the entry guard
  // were wrong, every test run would talk.
  assert.equal(typeof mod.main, 'undefined', 'main must not be exported as a side effect');
});

// ─── synthesis: the guards that turn a silent failure into a readable one ────

/**
 * A WAV with real chunks, which is the thing winsound actually accepts.
 *
 * This helper exists because the fixture that used to stand here was
 * `Buffer.alloc(64)` with `RIFF` at 0 and `WAVE` at 8 and NOTHING ELSE — no
 * `fmt `, no `data`, and a declared size of 0. It passed a 12-byte header sniff
 * and was called a valid WAV. That fixture is the bug: it certified as
 * "playable" a file that has no audio in it and no length, which is precisely
 * the shape the TTS server emits. A test that cannot tell a WAV from a
 * placeholder cannot guard playback.
 *
 * `streaming: true` reproduces the server's real output: the same PCM payload
 * with `data` and `RIFF` sizes set to 0xFFFFFFFF, the sentinel for "I have not
 * finished counting". Measured on the server's own clip: 508494 bytes, `fmt `
 * size 16, `LIST` size 26, `data` size 4294967295.
 */
function realWav({ streaming = false, pcmBytes = 2400 } = {}) {
  const SENTINEL = 0xFFFFFFFF;
  const fmt = Buffer.alloc(32); // 'fmt '+16 bytes = 24, then an 8-byte LIST header
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(24000, 12); // sample rate
  fmt.writeUInt32LE(48000, 16); // byte rate
  fmt.writeUInt16LE(2, 20); // block align
  fmt.writeUInt16LE(16, 22); // bits per sample
  fmt.write('LIST', 24);
  fmt.writeUInt32LE(0, 28);
  const data = Buffer.alloc(8 + pcmBytes);
  data.write('data', 0);
  data.writeUInt32LE(streaming ? SENTINEL : pcmBytes, 4);
  const body = Buffer.concat([fmt, data]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0);
  head.writeUInt32LE(streaming ? SENTINEL : body.length + 4, 4);
  head.write('WAVE', 8);
  return Buffer.concat([head, body]);
}

/** A fetchImpl that answers 200 with the given bytes. */
const servesWav = (buf) => async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
});
const TTS = { baseUrl: 'http://x/v1/', model: 'm', voice: 'v', speed: 1, format: 'wav' };

test('a 200 that is not a WAV is refused, not handed to the speaker', () => {
  // A misconfigured server answers 200 with JSON or an HTML page, and PlaySound
  // then fails naming neither cause.
  const notWav = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode('{"error":"nope"}').buffer
  });
  return mod.synthesize('hi', { baseUrl: 'http://x/v1', model: 'tts-1', voice: 'a', speed: 1, format: 'wav' }, notWav)
    .then((r) => {
      assert.equal(r.ok, false);
      assert.match(r.error, /RIFF|WAVE/);
    });
});

test('a non-http base URL is refused before any request', () => {
  return mod.synthesize('hi', { baseUrl: 'file:///etc/passwd', model: 'm', voice: 'v', speed: 1, format: 'wav' })
    .then((r) => {
      assert.equal(r.ok, false);
      assert.match(r.error, /not http/);
    });
});

test('a server error is reported with its status, truncated', () => {
  const failing = async () => ({
    ok: false,
    status: 503,
    text: async () => 'x'.repeat(5000)
  });
  return mod.synthesize('hi', { baseUrl: 'http://x/v1', model: 'm', voice: 'v', speed: 1, format: 'wav' }, failing)
    .then((r) => {
      assert.equal(r.ok, false);
      assert.match(r.error, /503/);
      assert.ok(r.error.length < 300, 'a stack trace must not bury the fact that it is down');
    });
});

test('a valid WAV is accepted', () => {
  const good = servesWav(realWav());
  return mod.synthesize('hi', TTS, good)
    .then((r) => {
      assert.equal(r.ok, true);
      assert.equal(r.repaired, false, 'a file with real sizes must not be touched');
      const info = mod.inspectWav(r.audio);
      assert.equal(info.ok, true);
      assert.equal(info.needsRepair, false);
      assert.equal(info.dataSize, 2400, 'the real PCM payload is intact');
    });
});

// ─── 058: the WAV the TTS server actually sends, and the claim it used to back ─

test('THE BUG: a header-only file passes a 12-byte sniff and is not playable', async () => {
  // This is the old test's fixture, kept as a test on purpose. It has a valid
  // RIFF/WAVE header and nothing else: no `fmt `, no `data`, no length. A
  // header sniff calls it a WAV; winsound cannot play it, and with flag 0 it
  // plays the SYSTEM DEFAULT SOUND instead and returns TRUE, which is how this
  // script came to print `spoke` having spoken nothing.
  const placeholder = Buffer.alloc(64);
  placeholder.write('RIFF', 0);
  placeholder.write('WAVE', 8);
  const info = mod.inspectWav(placeholder);
  assert.equal(info.ok, false, 'a header with no audio is not a playable WAV');
  assert.match(info.error, /fmt|data/i, 'the error must name what is missing');
  const r = await mod.synthesize('hi', TTS, servesWav(placeholder));
  assert.equal(r.ok, false, 'and it must not reach the speaker');
});

test('a STREAMING wav is recognised by its 0xFFFFFFFF sentinel, not refused', async () => {
  const streamed = realWav({ streaming: true });
  const info = mod.inspectWav(streamed);
  assert.equal(info.ok, true, 'the audio is real: only the lengths are missing');
  assert.equal(info.needsRepair, true, 'the sentinel must be detected, not accepted as-is');
});

test('repairing the header makes the file playable, which is the whole point', () => {
  const streamed = realWav({ streaming: true });
  const fixed = mod.repairWav(streamed, mod.inspectWav(streamed));
  // Byte-identical to what a server that finished counting would have sent.
  assert.ok(fixed.equals(realWav()), 'repair must write the real dimensions, nothing else');
  const after = mod.inspectWav(fixed);
  assert.equal(after.ok, true);
  assert.equal(after.needsRepair, false, 'a repaired file needs no further repair');
  assert.equal(after.dataSize, 2400);
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8, 'RIFF size counts everything after byte 8');
  assert.ok(!streamed.equals(fixed), 'the caller buffer must not be mutated');
});

test('synthesize repairs the sentinel instead of failing: the voice must WORK', async () => {
  const r = await mod.synthesize('Ciao.', TTS, servesWav(realWav({ streaming: true })));
  assert.equal(r.ok, true, 'fixing beats failing: this audio is playable');
  assert.equal(r.repaired, true, 'and the caller is told the header was rewritten');
  assert.ok(r.audio.equals(realWav()), 'what reaches the speaker is a valid WAV');
});

test('a sentinel with no repairable payload is refused, naming the cause', async () => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0); b.writeUInt32LE(0xFFFFFFFF, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.write('data', 28); b.writeUInt32LE(0xFFFFFFFF, 32); // but nothing after it
  const r = await mod.synthesize('hi', TTS, servesWav(b));
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown size|unplayable/i, 'the error must name the unknown size');
});

test('a fmt chunk too short to be PCM is refused', async () => {
  const b = realWav();
  b.writeUInt32LE(4, 12); // 'fmt ' size 12: not a format chunk
  const r = await mod.synthesize('hi', TTS, servesWav(b));
  assert.equal(r.ok, false);
  assert.match(r.error, /fmt/i);
});

// ─── 058: the rule — never say "done" without having played ──────────────────

test('SND_NODEFAULT is in the PlaySound call: no system-sound fallback', () => {
  // Pinned as a literal because it is otherwise untestable without playing audio
  // on the human's machine, and it is the single flag that decides whether an
  // unplayable file is a failure or a beep with a TRUE return.
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'resources', 'skills', 'md-voice-brief', 'voice-outbox.mjs'), 'utf8');
  assert.match(src, /PlaySound\(\$args\[0\], \[IntPtr\]::Zero, 2\)/,
    'flag 0 substitutes the default sound and returns TRUE: that is the false success');
});

test('an unsupported platform QUEUES the message instead of failing it', () => {
  const r = mod.playWavSync('x.wav', 'darwin');
  assert.equal(r.ok, false, 'nothing was played, so this is not ok');
  assert.equal(r.queued, true, 'and it must not be filed as a failure');
  assert.match(r.error, /LEFT QUEUED/i);
});

test('flushOne leaves the envelope in place when the platform cannot play', async () => {
  const { mkdtempSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-058-'));
  const name = 'msg-1.json';
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: 'msg-1', text: 'Ciao.', createdAt: 'now' }), 'utf8');
  const r = await mod.flushOne(dir, name, { userData: dir, fetchImpl: servesWav(realWav()), platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.queued, true);
  assert.ok(existsSync(join(dir, name)), 'the envelope must still be there: nothing is lost');
  assert.ok(!existsSync(join(dir, '.failed')), 'and it must NOT be filed as a failure');
  assert.ok(!existsSync(join(dir, '.done')), 'nothing was spoken, so nothing may be marked done');
  assert.deepEqual(readdirSync(dir), [name]);
});

test('a genuine failure still MOVES the envelope to .failed (a move, not a delete)', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-058-'));
  const name = 'msg-2.json';
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: 'msg-2', text: 'Ciao.', createdAt: 'now' }), 'utf8');
  const down = async () => ({ ok: false, status: 503, text: async () => 'down' });
  const r = await mod.flushOne(dir, name, { userData: dir, fetchImpl: down, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(r.queued, undefined, 'a dead server is a failure, not a platform limitation');
  assert.ok(existsSync(join(dir, '.failed', name)), 'the message must be preserved for the human');
  assert.ok(!existsSync(join(dir, name)));
});
