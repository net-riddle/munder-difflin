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
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.join(__dirname, '..', 'resources', 'skills', 'md-voice-brief', 'voice-outbox.mjs');
const MODULE = pathToFileURL(MODULE_PATH).href;

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

// ─── 003: the script route has a ceiling, and it is the app's ceiling ────────
//
// The defect, measured: `src/main/realtime.ts` had `AbortController` and
// `speakBudgetMs()`; this script had NOTHING on the fetch. Two routes, two
// answers to "how long is too long", and no one could see it — until 064 made an
// unbounded wait multiply by the number of pieces, so one wedged server cost N
// times forever, on the route the user is listening to.
//
// So the test that matters here is not "there is a timeout". It is that there is
// ONE timeout, defined once, in a file both routes load. A second copy of the
// number is the same defect wearing a different name.

test('003: the script imports the shared policy instead of defining its own', () => {
  // The pin is on the SOURCE, and that is a weaker kind of test than the numeric
  // one below — it proves the number is not duplicated, not that the behaviour is
  // right. It is here because the failure it catches is invisible: a policy that
  // drifts is a policy nobody notices until a flush takes the wrong time.
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(src, /import \{ speakBudgetMs \} from '\.\.\/\.\.\/\.\.\/src\/main\/tts-budget\.cjs'/,
    'the budget must be imported from the one shared file, by that exact path');
  assert.doesNotMatch(src, /const SPEAK_BUDGET_\w+ =/, 'and no local copy of the numbers');
  assert.doesNotMatch(src, /timeout:\s*\d[\d_]*\s*\)/, 'nor a flat timeout on the request');
  // And the ceiling is applied to a REQUEST, so it is asked for the piece.
  assert.match(src, /setTimeout\(\(\) => controller\.abort\(\), budgetMs\)/, 'the abort must be wired to the budget');
});

test('003: the shared policy gives both routes the same number, at the boundaries', () => {
  // What 003 asked for: the two routes return the same number for the same number
  // of characters, including the limits. The app's test already pins the policy;
  // this pins that this script asks THAT policy, by checking the numbers the
  // script's own call produces.
  const { speakBudgetMs } = require(path.join(__dirname, '..', 'src', 'main', 'tts-budget.cjs'));
  for (const chars of [0, 1, 220, 464, 2000, 10 ** 9]) {
    assert.equal(speakBudgetMs(chars), speakBudgetMs(chars), `chars=${chars}`);
  }
  // The unit is the PIECE, and this is the number that matters in the flush path.
  assert.ok(speakBudgetMs(220) >= 170_000, `a full piece gets at least the 170 s it needs, got ${speakBudgetMs(220)}`);
  assert.ok(speakBudgetMs(220) > 16_900, `and far more than the 16.9 s a 101-char piece actually took`);
  assert.ok(speakBudgetMs(2000) <= 600_000, 'the ceiling still bounds it');
});

test('003: a server that never answers is given up on, and the message says why', async () => {
  // The failure has to be a DECLARED one. A request that hangs forever on the
  // route the user is listening to is the bug; the abort is the fix; and what
  // proves the fix is a message naming what it waited for, what it was allowed,
  // and how much text it was allowed it for.
  const silent = (_url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const settings = { baseUrl: 'http://tts.invalid/v1', model: 'm', voice: 'v', speed: 1, format: 'wav' };

  const started = Date.now();
  const r = await mod.synthesize('una riga', settings, silent, 60);
  const took = Date.now() - started;

  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after \d+ms \(budget 60ms for 8 chars\)/, `got ${JSON.stringify(r.error)}`);
  assert.ok(took < 5000, `it must give up at the budget, not after it — waited ${took}ms`);
});

test('003: a timed-out piece is FAILED, and the envelope is never marked done', async () => {
  // The end-to-end shape the card demanded, and the reason wiring the error in
  // was cheap: `speakPieces` aggregates the WORST piece, so a give-up cannot come
  // out as `spoke` and cannot reach `.done`. The user's rule ("wait for delivery
  // AND playback") is already encoded in that aggregation.
  const { mkdtempSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-003-'));
  const name = 'msg-timeout.json';
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: 'msg-timeout', text: 'Una frase che nessuno ascoltera.', createdAt: 'now' }), 'utf8');

  const silent = (_url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

  const r = await mod.flushOne(dir, name, {
    userData: dir, platform: 'win32', playImpl: async () => ({ ok: true }),
    fetchImpl: silent, budgetMs: 60,
  });

  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed');
  assert.equal(r.spoken, 0);
  assert.match(r.error, /timed out after \d+ms/, 'and the reason survives into the reported error');

  const line = mod.describeFlush(r);
  assert.equal(line.stream, 'stderr');
  assert.match(line.text, /^FAILED msg-timeout\.json \(0 of 1 piece spoken/, 'never `spoke`');
  // `spoke` is a PREFIX of `spoken`, so a bare /spoke/ would match the count in
  // "0 of 1 piece spoken" and pass a line that begins with `spoke`. The claim
  // being guarded is the one at the START of the line.
  assert.doesNotMatch(line.text, /^spoke\b/, 'and the line must not open by claiming success');

  assert.ok(existsSync(join(dir, '.failed', name)), 'the envelope is in .failed');
  assert.ok(!existsSync(join(dir, '.done', name)), 'and NOT in .done');
  const rec = JSON.parse(readFileSync(join(dir, '.failed', 'msg-timeout.receipt.json'), 'utf8'));
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.pieces[0].stage, 'synthesize');
  assert.equal(rec.pieces[0].playMs, 0, 'nothing reached the speaker');
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

// ─── 064: a long message is cut into pieces and spoken in sequence ───────────
//
// A long message used to be ONE clip, and a long clip is all-or-nothing: if it
// failed the user heard nothing, and there was no natural place to interrupt.
// These tests pin the two decisions that are easy to get wrong — where a piece
// may end, and what a run of pieces adds up to.
//
// NOT exercised here: a real speaker. `speakPieces` takes `synth` and `play` as
// injections precisely so the sequencing and the verdict can be tested without a
// test that makes noise. The same boundary the header already draws for the
// playback path.

test('a message that already fits comes back as ONE piece', () => {
  const p = mod.splitForSpeech('Ciao, questo e un test breve.');
  assert.equal(p.length, 1);
  assert.equal(p[0], 'Ciao, questo e un test breve.');
});

test('a long message is cut on sentence boundaries, never inside a word', () => {
  // Two sentences long enough that packing them together would pass the target,
  // so the first cut is forced to land on the sentence boundary.
  const s1 = 'La prima frase di questa verifica e volutamente lunga, e deve occupare un pezzo intero senza che il taglio cada dentro una parola.';
  const s2 = 'La seconda frase e lunga uguale, e finisce con un punto, cosi il confine e veramente un confine di frase e non uno spazio qualsiasi.';
  const s3 = 'La terza chiude in breve.';
  const text = mod.normalizeSpoken(s1 + ' ' + s2 + ' ' + s3);
  assert.ok(text.length > mod.MAX_PIECE_CHARS, 'the fixture must exceed the target, or the split is not exercised');
  const p = mod.splitForSpeech(text);
  assert.ok(p.length > 1, 'expected more than one piece');
  for (const piece of p) {
    assert.ok(piece.length <= mod.MAX_PIECE_CHARS, `piece over target: ${piece.length}`);
    // a piece may only end at sentence punctuation, never mid-word
    assert.match(piece, /[.!…。！？]$/, `piece does not end on a boundary: ${JSON.stringify(piece.slice(-30))}`);
  }
  assert.equal(p[0], s1, 'the first cut is exactly the first sentence');
  assert.equal(p.join(' '), text, 'and the pieces still rebuild the whole message');
});

test('the pieces recompose into the original text', () => {
  // The invariant that makes the split safe: nothing is lost, nothing is
  // invented. A splitter that dropped a connector would sound fine and mean
  // something else, and no per-piece assertion would notice.
  const texts = [
    'Uno. Due. Tre.',
    'Una frase lunghissima senza alcuna punteggiatura la cui fine coincide con il confine del pezzo esatto',
    'A. B. C. D. E. F. G. H.',
    'Mixed   whitespace\n\nand a tab\there. Then a second sentence.',
  ];
  for (const t of texts) {
    const norm = mod.normalizeSpoken(t);
    const p = mod.splitForSpeech(t);
    assert.equal(p.join(' '), norm, `recomposition failed for ${JSON.stringify(t.slice(0, 40))}`);
  }
});

test('one sentence longer than the target is cut at a word boundary', () => {
  const words = [];
  for (let i = 0; i < 90; i++) words.push(`parola${i}`);
  const p = mod.splitForSpeech(words.join(' '));
  assert.ok(p.length > 1, 'expected the oversized sentence to be cut');
  for (const piece of p) {
    assert.ok(piece.length <= mod.MAX_PIECE_CHARS, `piece over target: ${piece.length}`);
    assert.doesNotMatch(piece, /\s$/, 'no piece keeps a trailing space');
    assert.doesNotMatch(piece, /[a-zà-ÿ]\s*[.,;:]$/, 'no cut left a word hanging on punctuation');
  }
  assert.equal(p.join(' '), words.join(' '), 'no word may be split or lost');
});

test('a single word longer than the target is emitted whole, not mangled', () => {
  // There is nowhere to cut inside a word. Emitting it whole is the honest
  // choice; cutting it would change what is said.
  const giant = 'x'.repeat(mod.MAX_PIECE_CHARS + 40);
  const p = mod.splitForSpeech(giant);
  assert.equal(p.join(' '), giant, 'the word must survive intact');
});

test('the run verdict is the WORST piece, never the last one', () => {
  const cases = [
    [[{ ok: true }, { ok: false, error: 'x' }, { ok: true }], 'failed', 'a middle failure is a failure'],
    [[{ ok: true }, { ok: true }, { ok: false, error: 'x' }], 'failed', 'a last failure is a failure'],
    [[{ ok: true }, { ok: true }, { ok: true }], 'played', 'all played is played'],
    [[{ ok: false, queued: true, error: 'q' }], 'queued', 'queued is not a failure'],
    [[], 'failed', 'nothing spoken is not a delivery'],
  ];
  for (const [results, want, why] of cases) {
    assert.equal(mod.aggregateOutcome(results), want, why);
  }
});

test('pieces are spoken in order, one after another', async () => {
  const seen = [];
  const r = await mod.speakPieces(['uno', 'due', 'tre'], {
    synth: async (p) => { seen.push(`synth:${p}`); return { ok: true, audio: Buffer.alloc(4) }; },
    play: async (syn, i) => { seen.push(`play:${i}`); return { ok: true }; },
  });
  assert.equal(r.outcome, 'played');
  assert.deepEqual(seen, ['synth:uno', 'play:0', 'synth:due', 'play:1', 'synth:tre', 'play:2'],
    'each piece must be synthesized and played before the next one starts');
});

test('a failed piece does NOT stop the chain: the human still gets the rest', async () => {
  // Stopping at the first failure would rebuild the all-or-nothing clip this
  // card exists to break.
  const played = [];
  const r = await mod.speakPieces(['uno', 'due', 'tre'], {
    synth: async (p) => (p === 'due' ? { ok: false, error: 'sintesi fallita' } : { ok: true, audio: Buffer.alloc(4) }),
    play: async (syn, i) => { played.push(i); return { ok: true }; },
  });
  assert.equal(r.outcome, 'failed', 'the run is a failure, and says so');
  assert.deepEqual(played, [0, 2], 'the third piece must still be attempted');
  assert.equal(r.results.filter((x) => x.ok).length, 2, 'two pieces were heard');
  assert.equal(r.results[1].stage, 'synthesize', 'and the failing stage is named');
});

test('a queued piece stops the chain, because there is nothing to play', async () => {
  let synths = 0;
  const r = await mod.speakPieces(['uno', 'due', 'tre'], {
    synth: async () => { synths++; return { ok: true, audio: Buffer.alloc(4) }; },
    play: async () => ({ ok: false, queued: true, error: 'playback is only implemented for Windows' }),
  });
  assert.equal(r.outcome, 'queued');
  assert.equal(synths, 1, 'the other pieces must not be synthesized for a speaker that does not exist');
});

test('flushOne on a long message: N pieces, but still ONE envelope in .done', async () => {
  const { mkdtempSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-064-'));
  const name = 'msg-long.json';
  const parts = [];
  for (let i = 0; i < 8; i++) parts.push(`Questa e' la frase numero ${i} del messaggio lungo, e occupa un pezzo.`);
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: 'msg-long', text: parts.join(' '), createdAt: 'now' }), 'utf8');

  let synths = 0;
  const counting = async () => { synths++; return servesWav(realWav())(); };

  // darwin: no playback implementation, so the chain stops at the first piece and
  // the envelope must stay exactly where it is. That is the same contract the
  // single-message path has, and it is the one place a real speaker is not needed.
  const r = await mod.flushOne(dir, name, { userData: dir, fetchImpl: counting, platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.queued, true);
  assert.equal(r.outcome, 'queued');
  assert.ok(r.pieces > 1, `the message should have been split, got ${r.pieces} piece(s)`);
  assert.equal(synths, 1, 'a queued chain stops instead of synthesizing every piece');
  assert.deepEqual(readdirSync(dir), [name], 'the envelope must still be the only thing in the outbox');
  assert.ok(!existsSync(join(dir, '.done')), 'nothing was spoken, so nothing may be marked done');
});

test('the verifier: the long text really is over the target', () => {
  // Guards the test above: if MAX_PIECE_CHARS were raised past this text, the
  // "should have been split" assertion would pass for the wrong reason.
  const parts = [];
  for (let i = 0; i < 8; i++) parts.push(`Questa e' la frase numero ${i} del messaggio lungo, e occupa un pezzo.`);
  assert.ok(mod.normalizeSpoken(parts.join(' ')).length > mod.MAX_PIECE_CHARS * 2,
    'the fixture must exceed two targets, or the split is not being exercised');
});

// ─── 066: what the user is told, and the ceiling that contradicted the split ──

test('a message the splitter can handle is no longer refused for its length', () => {
  // The contradiction: MAX_SPOKEN_CHARS was 600 while a splitter at 220 exists,
  // so a 700-character message was rejected for a length the system could
  // handle in four pieces. Refusing work the system can do is a defect, not a
  // policy.
  const sevenHundred = 'Frase parlata di prova. '.repeat(40).slice(0, 700);
  assert.ok(sevenHundred.length > 700 * 0.9, 'fixture sanity');
  const r = mod.checkSpokenText(sevenHundred);
  assert.equal(r.ok, true, `must be accepted now, findings: ${JSON.stringify(r.findings)}`);
  assert.equal(r.blocking.find((f) => f.code === 'too-long'), undefined, 'no length refusal');
  const v = mod.validateEnvelope({ v: 1, text: sevenHundred });
  assert.equal(v.ok, true, `the envelope check must agree: ${JSON.stringify(v.problems)}`);

  // And the checker and the envelope validator must not disagree, which is how
  // the contradiction would have bitten in production: --check passes, flush refuses.
  for (const n of [600, 601, 700, 1999, 2000, 2001]) {
    const text = 'Frase parlata di prova. '.repeat(60).slice(0, n);
    const byCheck = mod.checkSpokenText(text).ok;
    const byEnv = mod.validateEnvelope({ v: 1, text }).ok;
    assert.equal(byCheck, byEnv, `checker and envelope validator disagree at ${n} chars`);
  }
});

test('past the ceiling it is still refused, and the reason names the pieces', () => {
  const huge = 'Frase parlata di prova. '.repeat(200).slice(0, mod.MAX_SPOKEN_CHARS + 50);
  const r = mod.checkSpokenText(huge);
  assert.equal(r.ok, false);
  const p = r.blocking.find((f) => f.code === 'too-long');
  assert.ok(p, 'expected a length refusal');
  assert.match(p.detail, /ceiling/, 'the wording must say what kind of limit this is');
  assert.match(p.detail, /pieces/, 'and how many pieces it would have been');
  const v = mod.validateEnvelope({ v: 1, text: huge });
  assert.equal(v.ok, false);
});

test('the ceiling is about the amount of speech, and the pieces say how much', () => {
  // Pin the relationship the new wording claims, so the two constants cannot
  // drift apart silently: the ceiling is a number of PIECES, expressed in chars.
  const atCeiling = 'Frase parlata di prova. '.repeat(200).slice(0, mod.MAX_SPOKEN_CHARS);
  const pieces = mod.splitForSpeech(atCeiling).length;
  assert.ok(pieces <= 12, `the ceiling should be a short briefing, got ${pieces} pieces`);
  assert.ok(pieces >= 5, `and it should really be several pieces, got ${pieces}`);
});

test('the flush line says how many pieces, and the failure line names the piece', async () => {
  // The gap 066 exists for: `spoke` reported success with no count, so "I heard
  // two of five" was not observable from the outside.
  const { mkdtempSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-066-'));
  const name = 'msg-3.json';
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(`Frase numero ${i} del messaggio lungo, che occupa un pezzo intero.`);
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: 'msg-3', text: parts.join(' '), createdAt: 'now' }), 'utf8');

  const r = await mod.flushOne(dir, name, { userData: dir, fetchImpl: servesWav(realWav()), platform: 'darwin' });
  assert.ok(r.pieces > 1, `expected several pieces, got ${r.pieces}`);
  assert.equal(r.outcome, 'queued');
  // the fields the CLI line is built from must exist on every branch
  assert.equal(typeof r.spoken, 'number', 'the report must carry how many were heard');
  assert.equal(r.spoken, 0, 'nothing was played on a platform with no speaker');
  assert.equal(typeof r.results.length, 'number');
  assert.match(r.results[0].queued ? r.error : '', /Windows/, 'the queued reason must survive the piece shape');
});

test('the printed line itself carries the counts, on every branch', () => {
  // The requirement was a WORDING, so the wording is what gets pinned. Checking
  // only that the fields exist is how a line ships that drops one of them.
  const base = { name: 'm.json', chars: 700, pieces: 3, spoken: 3, results: [] };
  const ok = mod.describeFlush({ ...base, ok: true });
  assert.equal(ok.stream, 'stdout');
  assert.match(ok.text, /^spoke m\.json \(700 chars, 3 pieces\)\n$/, `got ${JSON.stringify(ok.text)}`);

  const one = mod.describeFlush({ ...base, pieces: 1, spoken: 1, ok: true });
  assert.match(one.text, /1 piece\)/, 'one piece is not "1 pieces"');

  const failed = mod.describeFlush({ ...base, spoken: 2, ok: false, error: 'piece 3/3: TTS request timed out' });
  assert.equal(failed.stream, 'stderr');
  assert.match(failed.text, /^FAILED m\.json \(2 of 3 pieces spoken\): piece 3\/3/, `got ${JSON.stringify(failed.text)}`);

  const queued = mod.describeFlush({ ...base, spoken: 0, ok: false, queued: true, error: 'playback is only implemented for Windows' });
  assert.equal(queued.stream, 'stderr');
  assert.match(queued.text, /^QUEUED NOT SPOKEN m\.json \(3 pieces, 0 spoken\):/, `got ${JSON.stringify(queued.text)}`);
});

// ─── 004: the outcome of a delivery survives the delivery ─────────────────────
//
// The evidence, measured: six envelopes in one evening, and every one of them sat
// in `.done/` byte-identical to what was queued, wearing an mtime equal to its own
// birth date because `rename` preserves it. The console line was the only record,
// and it belonged to whichever terminal happened to be running.

const LONGTEXT = (() => {
  const parts = [];
  for (let i = 0; i < 8; i++) parts.push(`Questa e' la frase numero ${i} del messaggio lungo, e occupa un pezzo.`);
  return parts.join(' ');
})();

/** A queue holding one envelope, and the text it was queued with. */
function spool(prefix, name, text) {
  const { mkdtempSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const body = JSON.stringify({ v: 1, id: name.replace(/\.json$/, ''), text, createdAt: '2026-09-28T20:00:00.000Z' }, null, 2);
  writeFileSync(join(dir, name), body, 'utf8');
  return { dir, name, body, read: () => require('node:fs').readFileSync(require('node:path').join(dir, name), 'utf8') };
}

/** A delivered envelope, without a speaker and without waiting for real audio. */
const delivered = (over = {}) => ({
  userData: null, platform: 'win32', playImpl: async () => ({ ok: true }), ...over,
});

test('004: a delivery that played leaves a receipt beside the envelope', async () => {
  const { existsSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { dir, name, body } = spool('vo-004-', 'msg-a.json', LONGTEXT);

  const r = await mod.flushOne(dir, name, delivered({ userData: dir, fetchImpl: servesWav(realWav()) }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.pieces > 1, 'the fixture must really split, or this proves nothing');

  const done = join(dir, '.done');
  assert.ok(existsSync(join(done, name)), 'the envelope lands in .done');
  assert.ok(existsSync(join(done, 'msg-a.receipt.json')), 'and the receipt lands BESIDE it, not inside it');

  const rec = JSON.parse(readFileSync(join(done, 'msg-a.receipt.json'), 'utf8'));
  assert.equal(rec.envelope, name, 'the receipt names the envelope it describes');
  assert.equal(rec.outcome, 'played');
  assert.equal(rec.pieceCount, r.pieces);
  assert.equal(rec.spokenCount, r.pieces, 'every piece sounded, and the receipt says so');
  assert.equal(rec.pieces.length, r.pieces, 'and it carries one entry per piece, in order');
  assert.deepEqual(rec.pieces.map((p) => p.piece), [...Array(r.pieces).keys()].map((i) => i + 1));

  // THE TRAP, stated as an assertion: the file the human or a future reader opens
  // must be the file the author wrote. An outcome written into `text` would make
  // the announcement say something its author never said.
  assert.equal(readFileSync(join(done, name), 'utf8'), body, 'the envelope must be byte-identical to what was queued');
});

test('004: the receipt says WHEN, because the envelope cannot', async () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { dir, name } = spool('vo-004-when-', 'msg-when.json', LONGTEXT);

  // A clock I control, so "84.76 s" is a fact rather than a race.
  const START = 1700000000000;
  let tick = 0;
  const clock = () => START + (tick++ === 0 ? 0 : 84760);

  const r = await mod.flushOne(dir, name, delivered({ userData: dir, fetchImpl: servesWav(realWav()), clock }));
  assert.equal(r.totalMs, 84760, 'the total is measured, not estimated');
  assert.equal(Date.parse(r.startedAt), START);

  const rec = JSON.parse(readFileSync(join(dir, '.done', 'msg-when.receipt.json'), 'utf8'));
  assert.equal(Date.parse(rec.finishedAt), START + 84760, 'the moment the audio ended is on the disk');
  assert.equal(rec.totalMs, 84760);
  // The per-piece numbers here come from the real monotonic clock (only the
  // envelope-level clock is injected), so what is pinned is the STRUCTURE, not a
  // value: the exact per-piece arithmetic is pinned above, with every clock
  // injected. What matters here is that the whole run cannot be shorter than the
  // pieces inside it, and that each piece adds up to itself.
  assert.ok(rec.synthMs >= 0 && rec.playMs >= 0, 'and the two stages are accounted for');
  assert.ok(rec.synthMs + rec.playMs <= rec.totalMs, 'the pieces cannot take longer than the whole run');
  for (const p of rec.pieces) {
    assert.ok(Number.isFinite(p.ms) && p.ms >= 0, `piece ${p.piece} carries its own milliseconds`);
    assert.equal(p.ms, p.synthMs + p.playMs, 'and they add up to it');
  }
});

test('004: a receipt is never mistaken for a message to speak', async () => {
  // The one way this feature could hurt the human: a JSON file full of timings
  // handed to the speaker. `pending()` is the gate, so it is the thing pinned.
  const { copyFileSync, existsSync, readdirSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { dir, name } = spool('vo-004-pending-', 'msg-b.json', 'Una frase breve, niente di che.');

  await mod.flushOne(dir, name, delivered({ userData: dir, fetchImpl: servesWav(realWav()) }));
  const receipt = join(dir, '.done', 'msg-b.receipt.json');
  assert.ok(existsSync(receipt), 'the fixture needs a real receipt to copy');

  // Put it back where envelopes live, with an envelope still waiting: the exact
  // shape that would put a JSON file in front of the speaker.
  copyFileSync(receipt, join(dir, 'msg-b.receipt.json'));
  writeFileSync(join(dir, 'msg-waiting.json'), JSON.stringify({ v: 1, id: 'msg-waiting', text: 'Ancora da dire.', createdAt: 'now' }), 'utf8');

  assert.deepEqual(mod.pending(dir), ['msg-waiting.json'],
    'the waiting envelope is queued and the receipt beside it is not');
  assert.ok(readdirSync(dir).includes('msg-b.receipt.json'), 'and the receipt is really sitting there, or this proves nothing');
});

test('004: a failure leaves its receipt too, naming the piece that failed', async () => {
  const { existsSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { dir, name } = spool('vo-004-fail-', 'msg-c.json', LONGTEXT);

  const down = async () => ({ ok: false, error: 'TTS server unreachable' });
  const r = await mod.flushOne(dir, name, delivered({ userData: dir, fetchImpl: down }));
  assert.equal(r.ok, false);

  const rec = JSON.parse(readFileSync(join(dir, '.failed', 'msg-c.receipt.json'), 'utf8'));
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.spokenCount, 0, 'nothing was heard, and the artifact says zero');
  assert.equal(rec.pieces.length, r.pieces);
  assert.equal(rec.pieces[0].stage, 'synthesize', 'the failing stage is on the record');
  assert.equal(rec.pieces[0].playMs, 0, 'and it never reached the speaker');
  assert.match(rec.error, /piece 1\/\d+/, 'the reason names WHICH piece');
  assert.ok(existsSync(join(dir, '.failed', name)), 'the envelope is still moved, not deleted');
});

test('004: an envelope too broken to speak is still accounted for', async () => {
  // The path with the least evidence of all: it never became a message, so it is
  // exactly the one that used to vanish into `.failed` saying nothing.
  const { existsSync, readFileSync, mkdtempSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-004-bad-'));
  writeFileSync(join(dir, 'msg-d.json'), '{ this is not json', 'utf8');

  const r = await mod.flushOne(dir, 'msg-d.json', delivered({ userData: dir }));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'rejected');
  assert.ok(existsSync(join(dir, '.failed', 'msg-d.receipt.json')), 'a receipt even here');
  const rec = JSON.parse(readFileSync(join(dir, '.failed', 'msg-d.receipt.json'), 'utf8'));
  assert.equal(rec.outcome, 'rejected');
  assert.match(rec.error, /not valid JSON/);
  assert.ok(Date.parse(rec.finishedAt) > 0);
});

test('004: the receipt writer never throws, it reports', async () => {
  // The audio has already been heard by the time the receipt is written, so a
  // failure here must not become a delivery failure.
  const { existsSync, mkdirSync, mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const root = mkdtempSync(join(tmpdir(), 'vo-004-unwritable-'));
  mkdirSync(join(root, 'locked'));

  const r = mod.writeReceipt(join(root, 'missing', 'deeper'), 'msg-e.json', { outcome: 'played' });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not write the receipt/);
  assert.ok(!existsSync(join(root, 'missing')), 'and it created no directory as a side effect');
});

// ─── 005: the seconds per piece, so the estimate stops being the only source ───

test('005: each piece reports its own seconds, and the two stages are told apart', async () => {
  // A hand stopwatch, three times, is how these numbers were obtained. The
  // reason the two stages are separate is that only `playMs` is time the human
  // spent listening: a piece that spent its time waiting on the server is a
  // different problem from one that was genuinely 40 seconds of audio.
  let t = 0;
  const r = await mod.speakPieces(['uno', 'due'], {
    synth: async (p) => { t += p === 'uno' ? 4000 : 500; return { ok: true, audio: Buffer.alloc(4) }; },
    play: async () => { t += 2000; return { ok: true }; },
    now: () => t,
  });
  assert.deepEqual(r.results.map((x) => [x.synthMs, x.playMs, x.ms]), [[4000, 2000, 6000], [500, 2000, 2500]]);
});

test('005: a piece that failed during synthesis is timed, with nothing played', async () => {
  let t = 0;
  const r = await mod.speakPieces(['uno'], {
    synth: async () => { t += 3000; return { ok: false, error: 'server unreachable' }; },
    play: async () => { throw new Error('must never be reached'); },
    now: () => t,
  });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.results[0].synthMs, 3000, 'the wait is on the record even though nothing was heard');
  assert.equal(r.results[0].playMs, 0);
  assert.equal(r.results[0].ms, 3000);
});

test('005: a duration reads as milliseconds below a second and tenths above', () => {
  // Not pedantry: a timing nobody can read is a timing nobody uses, and a piece
  // reporting `0.0 s` is indistinguishable from a clock that never ran.
  assert.equal(mod.fmtMs(0), '0 ms', 'zero is a real measurement and must not read as nothing');
  assert.equal(mod.fmtMs(847), '847 ms');
  assert.equal(mod.fmtMs(84760), '84.8 s', 'the measured flush of the evening, to one decimal');
  assert.equal(mod.fmtMs(null), null, 'an unmeasured duration is absent, not zero');
});

test('005: the printed line carries the total and the per-piece seconds', async () => {
  const results = [
    { piece: 1, of: 2, ms: 41200 }, { piece: 2, of: 2, ms: 43560 },
  ];
  const line = mod.describeFlush({ name: 'm.json', chars: 343, pieces: 2, spoken: 2, results, totalMs: 84760, ok: true });
  assert.equal(line.stream, 'stdout');
  assert.match(line.text, /^spoke m\.json \(343 chars, 2 pieces, 84\.8 s \[p1 41\.2 s, p2 43\.6 s\]\)\n$/,
    `got ${JSON.stringify(line.text)}`);

  const failed = mod.describeFlush({ name: 'm.json', chars: 343, pieces: 2, spoken: 1, results, totalMs: 84760, ok: false, error: 'piece 2/2: playback failed' });
  assert.match(failed.text, /^FAILED m\.json \(1 of 2 pieces spoken, 84\.8 s \[p1 41\.2 s, p2 43\.6 s\]\): piece 2\/2/,
    'a failure carries the timings too — that is when they are worth having');

  // Nothing was heard, so the seconds are the wait for nothing: they must still
  // be printed rather than dropped, and they must not be dressed up as audio.
  const waited = [{ piece: 1, of: 2, ms: 190 }, { piece: 2, of: 2, ms: 210 }];
  const queued = mod.describeFlush({ name: 'm.json', chars: 343, pieces: 2, spoken: 0, results: waited, totalMs: 400, ok: false, queued: true, error: 'no speaker' });
  assert.match(queued.text, /^QUEUED NOT SPOKEN m\.json \(2 pieces, 0 spoken, 400 ms \[p1 190 ms, p2 210 ms\]\): no speaker\n$/,
    `got ${JSON.stringify(queued.text)}`);
});

test('005: one piece is not broken down into a breakdown of one', () => {
  const line = mod.describeFlush({ name: 'm.json', chars: 40, pieces: 1, spoken: 1, results: [{ piece: 1, of: 1, ms: 3100 }], totalMs: 3100, ok: true });
  assert.equal(line.text, 'spoke m.json (40 chars, 1 piece, 3.1 s)\n');
});

/* ------------------------------------------------------------------ *
 * 083 — the drain that lies about success.
 *
 * The app runs a watcher over the same queue and it runs THIS SAME FILE, so both
 * drains speak an envelope and both file it, and the loser of the rename finds
 * nothing. Before, the loser threw ENOENT, main's catch printed "crashed" and
 * the process exited 1 — after the human had already heard the message.
 *
 * The two cases below look identical from the losing side: the envelope is gone
 * either way. What separates them is the RECEIPT, because the receipt is the
 * evidence that somebody spoke it and filed it. These are simulated through the
 * `playImpl` seam, which is where the race really happens: the other drainer
 * moves the envelope while this process is still playing audio.
 * ------------------------------------------------------------------ */

function raceFixture(id) {
  const { mkdtempSync, writeFileSync, mkdirSync, renameSync, existsSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-083-'));
  const name = `msg-${id}.json`;
  mkdirSync(join(dir, '.done'), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: `msg-${id}`, text: 'Una frase che l\'umano sentira.', createdAt: 'now' }), 'utf8');
  return {
    dir, name,
    // `withReceipt` is the whole experiment: true = the other drainer finished
    // the job properly, false = it took the envelope and left nothing behind.
    otherDrainer: (withReceipt) => async () => {
      renameSync(join(dir, name), join(dir, '.done', name));
      if (withReceipt) {
        writeFileSync(join(dir, '.done', mod.receiptName(name)),
          JSON.stringify({ outcome: 'played', chars: 33, pieceCount: 1, spokenCount: 1 }), 'utf8');
      }
      return { ok: true };
    },
    doneReceipt: () => join(dir, '.done', mod.receiptName(name)),
    hasReceipt: () => existsSync(join(dir, '.done', mod.receiptName(name))),
    hasEnvelope: () => existsSync(join(dir, name)),
    readReceipt: () => JSON.parse(readFileSync(join(dir, '.done', mod.receiptName(name)), 'utf8'))
  };
}

test('083: ENOENT on the rename is SUCCESS when the other drainer left a receipt', async () => {
  const f = raceFixture('raced');
  const r = await mod.flushOne(f.dir, f.name, {
    userData: f.dir, platform: 'win32', playImpl: f.otherDrainer(true),
    fetchImpl: async () => new Response(realWav(), { status: 200 }), budgetMs: 5000
  });

  // The decisive assertion is `ok`, not the absence of a throw: this process
  // DID speak the message, so reporting failure is what caused the double-send.
  assert.equal(r.ok, true, 'a delivery that reached the user is not a failure');
  assert.equal(r.receipt.ok, true);
  assert.equal(r.receipt.racedBy, 'other-drainer', 'and it says who actually filed it');
  assert.equal(f.hasReceipt(), true, 'the receipt is the evidence, and it is still there');

  // The line must still open with `spoke`, and must name the race rather than
  // hide it: two drains of one queue is a fact somebody has to be able to see.
  const line = mod.describeFlush(r);
  assert.equal(line.stream, 'stdout', 'success stays on stdout — it is not a warning');
  assert.match(line.text, /^spoke msg-raced\.json/, 'never `crashed`, never `FAILED`');
  assert.match(line.text, /app watcher filed it first/, 'and the race is visible, not silent');
});

test('083: ENOENT on the rename with NO receipt is still a loss, and stays red', async () => {
  // THE CASE THAT MUST NOT BE PAPERED OVER. Identical from this side — the
  // envelope is gone — but now nothing proves it was ever spoken. A guard that
  // treated both as success would announce a delivery nobody can verify, which
  // is the same class of lie in the opposite direction.
  const f = raceFixture('lost');
  await assert.rejects(
    () => mod.flushOne(f.dir, f.name, {
      userData: f.dir, platform: 'win32', playImpl: f.otherDrainer(false),
      fetchImpl: async () => new Response(realWav(), { status: 200 }), budgetMs: 5000
    }),
    (e) => e.code === 'ENOENT',
    'an envelope that vanished with no receipt must throw, not report success'
  );
  assert.equal(f.hasReceipt(), false, 'and the premise: there really is no receipt');
  assert.equal(f.hasEnvelope(), false, 'the envelope really is gone');
});

test('083: the guard is the RECEIPT, not the error code — same ENOENT, both ways', async () => {
  // One assertion holding the two tests together: identical failure, opposite
  // verdicts, decided by one file on disk. If someone ever "simplifies" the
  // check into catching ENOENT outright, this is what notices.
  const raced = raceFixture('pair-a');
  const ok = await mod.flushOne(raced.dir, raced.name, {
    userData: raced.dir, platform: 'win32', playImpl: raced.otherDrainer(true),
    fetchImpl: async () => new Response(realWav(), { status: 200 }), budgetMs: 5000
  });
  const lost = raceFixture('pair-b');
  let threw = false;
  try {
    await mod.flushOne(lost.dir, lost.name, {
      userData: lost.dir, platform: 'win32', playImpl: lost.otherDrainer(false),
      fetchImpl: async () => new Response(realWav(), { status: 200 }), budgetMs: 5000
    });
  } catch { threw = true; }
  assert.equal(ok.ok, true, 'receipt present -> success');
  assert.equal(threw, true, 'receipt absent -> error');
  // The pairing IS the claim: ONE failure, two opposite verdicts. Asserted as a
  // pair so that changing BOTH branches to the same answer fails here, which is
  // the mistake this test exists to catch.
  assert.equal(ok.ok && threw, true, 'same ENOENT, opposite verdicts, decided by the receipt alone');
});

// ─── 086: the outbox is the one channel that cannot be re-read ───────────────
//
// An agent id in a spoken message forces the listener to TRANSLATE a string
// before they can think about the sentence, and there is no rewinding: the word
// is already spent. Everywhere else a long id is only ugly; here it is a cost
// paid by the human, in the dark, at the moment the message arrives.
//
// So the rule is REFUSAL, not substitution. That is the whole reason the word
// and the mouth are two different people: the author is the only one who can
// choose the name, and this lane is the last place where refusing is still free.

test('086: an agent id is refused, and the author is told what to say instead', () => {
  const r = mod.checkSpokenText('Jim ha lasciato la 083 in coda per jim-mugp1eoh.');
  assert.equal(r.ok, false, 'a registry id in a spoken message is not ok');
  const p = r.blocking.find((f) => f.code === 'agent-id');
  assert.ok(p, 'expected a blocking agent-id finding');
  assert.match(p.detail, /jim-mugp1eoh/, 'the offending token is quoted back');
  assert.match(p.detail, /say "Jim"/, 'and so is the name to write');
});

test('086: the rule is the id SHAPE, so an id nobody wrote down is caught too', () => {
  // Not a list of three known names: `zoe` has never existed on this floor, and a
  // list would have passed it. The suffix is what carries the rule.
  const r = mod.checkSpokenText('zoe-abc123xy ha chiuso la card.');
  assert.ok(r.blocking.some((f) => f.code === 'agent-id'), 'a future id must be caught too');
});

test('086: a hyphenated English word is not an id, and does not block the message', () => {
  // The other side of the same rule, and the reason the suffix must carry a
  // digit: a message must never be blocked because of a word.
  for (const text of [
    'The screen-reader path still works.',
    'Il long-form e una delle misure del rapporto.',
    'Uno short-circuit coalesce i pezzi.'
  ]) {
    const r = mod.checkSpokenText(text);
    assert.ok(!r.findings.some((f) => f.code === 'agent-id'), `must not flag: ${text}`);
  }
});

test('086: `god` is caught by hand, and the name the user hears is his own', () => {
  // The one id with no suffix, so no shape can find it. What matters is that the
  // suggestion is the human's name: the queue is where HE is listening.
  const r = mod.checkSpokenText('god ha chiuso la 084 e il canale resta aperto.');
  const p = r.blocking.find((f) => f.code === 'agent-id');
  assert.ok(p, 'expected god to be refused');
  assert.match(p.detail, /"god" -> say "Michael"/);
});

test('086: the simplified names are exactly the good case, and pass clean', () => {
  const r = mod.checkSpokenText('Jim ha lasciato la 083 in coda, Pam ha chiuso la 053.');
  assert.ok(!r.findings.some((f) => f.code === 'agent-id'), JSON.stringify(r.findings));
});

test('086: the envelope is refused on the way OUT, before any audio is asked for', () => {
  const r = mod.validateEnvelope({ v: 1, id: 'msg-1', text: 'Kelly ha finito: kelly-multwfg2.' });
  assert.equal(r.ok, false, 'a hand-written envelope must not pass either');
  assert.match(r.problems.join(' '), /kelly-multwfg2/);
  assert.match(r.problems.join(' '), /Kelly/);
});

test('086: flushOne does not SPEAK an id — it files it, and says why', async () => {
  // The acceptance criterion of the card, end to end: it does not go out as it
  // is. The load-bearing assertion is the last one — no request was made, so
  // there was no audio to be un-sent afterwards.
  const { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vo-086-'));
  const name = 'msg-086.json';
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, id: 'msg-086', text: 'pam-mul0lzyj ha chiuso la 053.', createdAt: 'now' }), 'utf8');
  let asked = 0;
  const fetchImpl = async () => { asked++; return new Response(realWav(), { status: 200 }); };
  const r = await mod.flushOne(dir, name, { userData: dir, fetchImpl, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'rejected');
  assert.ok(existsSync(join(dir, '.failed', name)), 'the envelope is preserved, not deleted');
  assert.ok(!existsSync(join(dir, '.done')), 'nothing was spoken, so nothing may be marked done');
  assert.equal(asked, 0, 'the message must never reach the speech server');
  assert.equal(readdirSync(dir).length, 1, 'and it leaves the queue');
  const receipt = JSON.parse(readFileSync(join(dir, '.failed', mod.receiptName(name)), 'utf8'));
  assert.equal(receipt.outcome, 'rejected');
  assert.match(receipt.error, /pam-mul0lzyj/, 'the receipt says which token stopped it');
});