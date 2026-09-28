#!/usr/bin/env node
/**
 * voice-outbox — drain a spoken-message queue and play it, with no app change.
 *
 * WHY THIS EXISTS, and why it is a separate process
 *
 * The app already knows how to speak: `main/realtime.ts` has `speak()`, the
 * renderer has a sentence queue with barge-in, and the user picks an output
 * device in Settings → Voice. All of it is reachable ONLY through renderer IPC,
 * because the renderer is what owns the `<audio>` element and the device sink.
 *
 * A worker agent is not the renderer. It runs in a PTY, on a CLI, with no bridge.
 * So the two options are: teach the app to watch a directory (a code change), or
 * teach a script to speak (this file). This is the second, so the skill works
 * against a running install — including one already up — with nothing rebuilt.
 *
 * WHAT THIS DOES NOT DO, DELIBERATELY
 *
 * It plays on the OS default device, not the device chosen in Settings, and it
 * does not join the app's queue, so it can talk over an in-flight clip. That is
 * the honest cost of not touching the app. The moment a directory watcher is
 * added to main (see docs/voice-outbox-design.md), this file becomes a
 * development convenience and the skill keeps working unchanged: the envelope
 * format below IS the seam, and it is designed to be drained by either side.
 *
 * ENVELOPE — the whole contract, in four fields
 *
 *   <userData>/voice-outbox/<id>.json
 *   { "v": 1, "id": "…", "text": "…", "voice": "fable"? }
 *
 * Flat, versioned, and carrying only the text plus an optional voice override.
 * An in-app watcher needs exactly this and nothing more, which is why the
 * format is deliberately not a "job" object with retries and callbacks.
 *
 * MOVES, not deletes. A spoken envelope lands in `.done/`; one that could not be
 * spoken lands in `.failed/` with the reason. A queue that deletes on failure
 * loses a message the user was told to expect, and nobody can tell it apart from
 * a queue that never ran.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ─── limits ──────────────────────────────────────────────────────────────────

/** Hard ceiling on one announcement.
 *
 *  Beyond this the TTS produces a minute of audio nobody asked for: a voice
 *  notification is a sentence or two, and a long one is indistinguishable from a
 *  stuck speaker. The app's own task-title cap is 140; a message is allowed more
 *  room, but not unbounded room. */
export const MAX_SPOKEN_CHARS = 600;

/** Above this, warn. Not a failure — some answers genuinely need a sentence more —
 *  but the author should know it is a long announcement before it is sent. */
export const WARN_SPOKEN_CHARS = 400;

// ─── paths ───────────────────────────────────────────────────────────────────

/**
 * The app's userData directory, mirrored from `app.getPath('userData')`.
 *
 * Duplicated rather than imported because this script runs under plain Node
 * with no Electron and no access to the app's modules — and because an agent
 * working in a PTY has to be able to find it without the app being involved.
 * `MD_USER_DATA` overrides it, which is what the tests and any unusual install
 * use.
 */
export function resolveUserData(env = process.env, platform = process.platform) {
  const override = env.MD_USER_DATA;
  if (override) return resolve(override);
  if (platform === 'win32') {
    const base = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'munder-difflin');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'munder-difflin');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'munder-difflin');
}

export function outboxDir(userData) {
  return join(userData, 'voice-outbox');
}

// ─── the TTS settings, read from the app's own config ────────────────────────

/**
 * The four fields that decide how a message sounds, taken from the SAME
 * `config.json` the Settings screen writes.
 *
 * Reading them here rather than hardcoding a voice is the point: the user picks
 * `fable` @ 1.25× in Settings → Voice, and a message spoken by an agent sounds
 * like Michael, not like a different machine. A missing or partial config falls
 * back to the same defaults `main/config.ts` ships, so a fresh install works.
 */
export function resolveTtsSettings(config, overrides = {}) {
  const c = (config && typeof config === 'object') ? config : {};
  /** An override wins, then the config key, then the shipped default. An EMPTY
   *  override is ignored on purpose: `''` means "not specified", and letting it
   *  through would produce a voice-less synthesis request. */
  const pick = (configKey, overrideKey, fallback) => {
    const v = overrides[overrideKey] ?? c[configKey];
    return v === undefined || v === null || v === '' ? fallback : v;
  };
  return {
    baseUrl: String(pick('realtimeTtsBaseUrl', 'baseUrl', 'http://localhost:8000/v1')),
    model: String(pick('realtimeTtsModel', 'model', 'tts-1')),
    voice: String(pick('realtimeTtsVoice', 'voice', 'alloy')),
    speed: Number(pick('realtimeTtsSpeed', 'speed', 1)) || 1,
    /** WAV, not mp3: winsound plays PCM WAV with no codec, and the app's own
     *  format setting is for a browser sink that has decoders we do not. */
    format: 'wav',
    /** Which voice engine is configured. `local-tts` is the only mode where a
     *  message needs this script — in cloud mode Michael speaks the outbox
     *  message himself, and speaking it here too would double it. */
    backend: String(c.realtimeVoiceBackend || 'openai')
  };
}

export function readConfig(userData) {
  const p = join(userData, 'config.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // A missing or unreadable config is not fatal: the defaults above are the
    // same ones the app ships, so a message still gets spoken. The BOM strip
    // mirrors main/hive.ts readJson, because a PowerShell-edited config on
    // Windows routinely has one and JSON.parse would throw on it.
    return {};
  }
}

// ─── envelope validation ─────────────────────────────────────────────────────

/**
 * Whether an envelope is safe to speak, and what is wrong with it if not.
 *
 * Returns findings rather than throwing, because the caller is an AGENT: the
 * useful behaviour is "here is what to fix", not a stack trace. An empty queue
 * entry, a future `v`, or a non-string `text` all have to be survivable — the
 * queue is a directory on disk that anything can put a file in.
 */
export function validateEnvelope(env) {
  const problems = [];
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, problems: ['envelope is not an object'] };
  }
  if (env.v !== 1) problems.push(`unsupported envelope version ${JSON.stringify(env.v)} (expected 1)`);
  if (typeof env.text !== 'string' || !env.text.trim()) {
    problems.push('text is empty — there is nothing to speak');
  }
  if (env.voice !== undefined && typeof env.voice !== 'string') {
    problems.push('voice must be a string when present');
  }
  if (typeof env.text === 'string' && env.text.length > MAX_SPOKEN_CHARS) {
    problems.push(`text is ${env.text.length} characters, over the ${MAX_SPOKEN_CHARS} limit for one spoken message`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The spoken-text problems an author cannot see in an editor.
 *
 * Every rule here exists because the failure is AUDIBLE, not visual: a path read
 * character by character is unintelligible, a markdown asterisk is read as a word
 * or silently dropped by the TTS, and a bulleted list becomes a run-on. A reviewer
 * reading the same text on screen sees none of it.
 *
 * Reported, never auto-fixed. Mechanically stripping markdown produces broken
 * sentences ("the file  is ready") which are worse than the original, so the
 * author is told and fixes it themselves.
 */
export function checkSpokenText(text) {
  const t = String(text ?? '');
  const findings = [];
  if (!t.trim()) return { ok: false, findings: ['text is empty'] };

  const add = (code, detail) => findings.push({ code, detail });

  // Markup a TTS either skips or pronounces.
  if (/^#{1,6}\s/m.test(t)) add('heading', 'starts a line with # — a heading marker is not spoken');
  if (/^\s*[-*+]\s/m.test(t)) add('bullet', 'contains a bulleted list — a voice reads it as a run-on');
  if (/\*\*|__/.test(t)) add('bold', 'contains ** or __ emphasis markers');
  if (/`/.test(t)) add('code', 'contains backticks — inline code is not speakable');
  if (/\|\s*-{2,}/.test(t)) add('table', 'contains a markdown table');
  if (/^\s*[-=*]{3,}\s*$/m.test(t)) add('hr', 'contains a horizontal rule');

  // Characters that become noise.
  if (/https?:\/\//i.test(t)) add('url', 'contains a URL — it is unreadable aloud');
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) add('link', 'contains a markdown link');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) {
    add('emoji', 'contains an emoji — some voices name them out loud');
  }
  if (/\([^()]*\([^()]*\)/.test(t)) add('nested-parens', 'contains nested parentheses, which flatten badly when spoken');
  if (/\.{3,}|…/.test(t)) add('ellipsis', 'contains an ellipsis, which a voice renders as a pause of unknown length');

  // Technical content: legible on screen, unusable in the ear.
  //
  // Both separators, because the separator is the only thing that differs by
  // platform and a Windows agent writes `src\main\realtime.ts` — which a
  // forward-slash-only pattern does not see at all, so the single most common
  // case on the machine this ships on would have gone unchecked.
  const paths = t.match(/(?:^|\s)[^\s]*[\\/][^\s]*[\\/][^\s]*\.[A-Za-z0-9]{1,6}(?=\s|$|[,.;:!?])/g);
  if (paths) {
    add('path', `contains a file path (${paths[0].trim()}) — say what the file IS, not where it lives`);
  }
  if (/\b[0-9a-f]{7,}\b/i.test(t)) add('hash', 'contains what looks like a commit hash');
  if (/^[A-Z_]{3,}(\s|$)/m.test(t)) add('shout', 'contains a SHOUTED WORD, which the voice cannot convey');
  if (/\bTODO\b|\bFIXME\b|\bXXX\b/.test(t)) add('marker', 'contains a TODO/FIXME marker meant for a screen, not an ear');

  if (t.length > MAX_SPOKEN_CHARS) {
    add('too-long', `${t.length} characters, over the ${MAX_SPOKEN_CHARS} limit for one spoken message`);
  } else if (t.length > WARN_SPOKEN_CHARS) {
    add('long', `${t.length} characters — a long announcement; consider whether one sentence would do`);
  }

  // Whitespace is free to fix here because a change cannot alter the meaning.
  if (/\n{2,}/.test(t)) add('blank-lines', 'contains blank lines, which add silence when read aloud');
  if (/^\s+|\s+$/.test(t)) add('edge-space', 'has leading or trailing whitespace');
  if (/\s{2,}/.test(t.trim())) add('double-space', 'contains runs of spaces');

  const hard = findings.filter((f) => !['long', 'blank-lines', 'edge-space', 'double-space'].includes(f.code));
  return { ok: hard.length === 0 && !!t.trim(), findings, blocking: hard };
}

/**
 * The text actually handed to the TTS.
 *
 * Only whitespace is normalized — the TTS reads a literal newline as a pause and
 * a run of spaces as nothing, so collapsing them is a strict improvement.
 * Nothing else is rewritten, because `checkSpokenText` already told the author
 * about everything that needed a human decision.
 */
export function normalizeSpoken(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// ─── playback ────────────────────────────────────────────────────────────────

/**
 * Play a WAV file and resolve when it has finished.
 *
 * `SND_SYNC` (0x0000) is the important flag, not an accident: it makes
 * PlaySound block until the clip ends, so a queue drains in order instead of
 * every message cutting the last one off.
 *
 * `SND_NODEFAULT` (0x0002) IS used, and the earlier note in this file said the
 * opposite — that the flag "returns FALSE and plays nothing" and therefore
 * "silently disables playback". That reading was wrong, and the reason it was
 * wrong is worth keeping: the FALSE was winsound correctly reporting that the
 * FILE was not playable, and the diagnosis blamed the API instead of the input.
 * The file it was handed had `data` and `RIFF` sizes of 0xFFFFFFFF, so winsound
 * could not compute a duration and refused it. That is what the flag reports.
 *
 * Measured, on the same clip, and the two numbers differ by three orders of
 * magnitude, which is the tell:
 *   PlaySound(path, 0, 2)  -> FALSE in 0 ms      (the file, honestly refused)
 *   PlaySound(path, 0, 0)  -> TRUE  in 1490 ms  (10.6 s of audio that never played)
 *   PlaySound(NULL, 0)     -> TRUE  in 2 ms     (the system default sound)
 *
 * So flag 0 was not "playing the file": it was the system default beep, and a
 * TRUE return. The script printed `spoke` and moved the envelope to `.done`, so
 * it reported success having spoken nothing — the exact failure this file was
 * written to prevent. With SND_NODEFAULT there is no fallback to fall back to: an
 * unplayable file is a hard failure, and `execFileSync` throws.
 *
 * Blocking semantics are unchanged. SND_SYNC is 0x0000, and what makes PlaySound
 * non-blocking is the presence of SND_ASYNC, not the absence of SND_SYNC, so
 * flag 2 blocks until the clip ends exactly as flag 0 did.
 *
 * PowerShell is the only playback surface available to a plain Node process on
 * Windows without a dependency, and winsound needs no codec for the PCM WAV the
 * TTS server returns. The script is written to a temp file rather than passed
 * with `-Command`, because the audio path can contain characters a shell would
 * eat.
 */
export function playWavSync(wavPath, platform = process.platform) {
  if (platform !== 'win32') {
    // DECISION, and the reason it matters: this is NOT a failure, so the envelope
    // is NOT consumed. Moving it to `.failed/` would record a failure that did
    // not happen, and — worse — would hide a perfectly valid message from the
    // in-app watcher that is the first follow-up in the design notes: that
    // watcher drains the same directory, and a message parked in `.failed/` is
    // invisible to it. So the envelope stays pending, the reason is reported, and
    // the caller is told the message was queued and NOT spoken.
    //
    // It still does not exit 0. "Queued, not spoken" is not "delivered": the
    // human's rule is that a path claiming success without having played is the
    // defect, and a zero exit here would be that defect wearing a different hat.
    return {
      ok: false,
      queued: true,
      error: 'playback is only implemented for Windows (winsound). The envelope is LEFT QUEUED, not spoken and not failed. On macOS/Linux let the app speak it: the in-app watcher drains this same directory.'
    };
  }
  // The path is passed as an ARGUMENT, never interpolated into the script body.
  // Doubling backslashes to "escape" it is what a JS author reaches for, and it
  // is exactly wrong here: PowerShell has no backslash escape, so `C:\\Temp\\x`
  // is a path with empty components and PlaySound simply returns false — with
  // an error that names neither the path nor the cause.
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$sig = @\'',
    '[DllImport("winmm.dll", CharSet=CharSet.Auto, SetLastError=true)]',
    'public static extern bool PlaySound(string pszSound, IntPtr hmod, uint fdwSound);',
    '\'@',
    '$t = Add-Type -MemberDefinition $sig -Namespace NativeMd -Name Audio -PassThru',
    'if (-not (Test-Path $args[0])) { throw "audio file is gone: $($args[0])" }',
    // Flag 2 = SND_NODEFAULT (SND_SYNC is 0, and only SND_ASYNC would make this
    // non-blocking, so it still blocks until the clip ends). Without it a file
    // winsound cannot play falls back to the SYSTEM DEFAULT SOUND and returns
    // TRUE, which is how this script came to report `spoke` having spoken
    // nothing. An unplayable file must be a failure, not a beep.
    'if (-not $t::PlaySound($args[0], [IntPtr]::Zero, 2)) { throw "PlaySound returned false (audio not playable, no default sound substituted)" }'
  ].join("\n");
  const ps1 = join(tmpdir(), `md-voice-${randomUUID().slice(0, 8)}.ps1`);
  try {
    writeFileSync(ps1, ps, 'utf8');
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, wavPath
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    return { ok: true };
  } catch (e) {
    const detail = ((e.stderr || '') + (e.stdout || '') || e.message || '').toString().trim().split('\n')[0];
    return { ok: false, error: detail || 'playback failed' };
  } finally {
    try { unlinkSync(ps1); } catch { /* best effort */ }
  }
}

// ─── synthesis ───────────────────────────────────────────────────────────────

/**
 * The size a streaming TTS server writes when the final length is not yet known.
 *
 * 0xFFFFFFFF is not a plausible file size and not a plausible duration, so it is
 * unambiguous rather than merely suspicious: it is the one value that can only
 * mean "I have not finished counting".
 */
const WAV_STREAMING_SENTINEL = 0xFFFFFFFF;

/** Chunks are word-aligned: an odd-sized chunk is followed by a pad byte. */
const padTo = (n) => (n % 2 === 0 ? n : n + 1);

/**
 * Walk the RIFF chunks of a WAV buffer.
 *
 * Why a walk and not a header sniff. A `RIFF....WAVE` check passes on a file
 * winsound will refuse to play, because the header of a STREAMING wav is well
 * formed and its SIZES are not. Measured on this platform against the TTS
 * server's own output:
 *
 *     file 508494 bytes
 *       chunk 'fmt '  size=16
 *       chunk 'LIST' size=26
 *       chunk 'data' size=4294967295   <- 0xFFFFFFFF, a sentinel, not a length
 *     RIFF declared size = 4294967295   <- same sentinel
 *
 * winsound cannot compute the duration of a file whose `data` size is unknown, so
 * it REJECTS it: `PlaySound(path, 0, 2)` measured FALSE in 0 ms. The old
 * guarantee in this file — "the clip is a real RIFF/WAVE" — could not see this,
 * because the sentinel lives past the first twelve bytes. The check that existed
 * to stop the script claiming a false success was itself the reason it claimed
 * one.
 *
 * Returns `{ ok, error, dataOffset, dataSize, needsRepair }`. `needsRepair` is
 * true when the audio is playable PCM but its declared sizes are sentinels.
 */
export function inspectWav(buf) {
  const bad = (error) => ({ ok: false, error, dataOffset: -1, dataSize: -1, needsRepair: false });
  if (!buf || buf.length < 12) return bad('audio is shorter than a WAV header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return bad('not a RIFF/WAVE file');
  }
  const declaredRiff = buf.readUInt32LE(4);
  let offset = 12;
  let fmtOk = false;
  let dataOffset = -1;
  let dataSize = -1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      // 16 is PCM; 18 adds cbSize, 40 is WAVE_FORMAT_EXTENSIBLE. All are valid,
      // all are at least 16, and anything shorter is not a format chunk.
      if (size >= 16 && body + 16 <= buf.length) fmtOk = true;
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
      break; // `data` is the payload; nothing after it matters for playback
    }
    offset = body + padTo(size);
    if (size === WAV_STREAMING_SENTINEL) {
      // A sentinel before `data` means the walk cannot continue meaningfully.
      return bad(`chunk '${id}' declares an unknown size (0xFFFFFFFF): the server streamed this file without a final length`);
    }
  }
  if (!fmtOk) return bad('no usable `fmt ` chunk (expected at least 16 bytes)');
  if (dataOffset < 0) return bad('no `data` chunk: the file carries no audio');
  const sentinelData = dataSize === WAV_STREAMING_SENTINEL || dataOffset + dataSize > buf.length;
  const sentinelRiff = declaredRiff === WAV_STREAMING_SENTINEL || declaredRiff + 8 > buf.length;
  if (sentinelData || sentinelRiff) {
    // The audio is real; only the lengths are missing. That is repairable, and
    // repairing it is the difference between a voice that works and an honest
    // failure.
    return {
      ok: true,
      error: null,
      dataOffset,
      dataSize: buf.length - dataOffset,
      needsRepair: true
    };
  }
  return { ok: true, error: null, dataOffset, dataSize, needsRepair: false };
}

/**
 * Write the real dimensions into a buffer whose header carries streaming
 * sentinels, so winsound can compute a duration and play the audio.
 *
 * Returns a NEW buffer; the input is not mutated, because the caller may still
 * want to report on what the server actually sent.
 */
export function repairWav(buf, info) {
  if (!info || !info.needsRepair) return buf;
  const out = Buffer.from(buf); // copy: never mutate the caller's bytes
  out.writeUInt32LE(out.length - 8, 4); // RIFF size counts everything after byte 8
  out.writeUInt32LE(out.length - info.dataOffset, info.dataOffset - 4);
  return out;
}

/**
 * Ask the TTS server for the clip. Returns the raw audio bytes, or the reason.
 *
 * Non-2xx bodies are truncated to a line: a TTS server that is down answers with
 * an HTML error page or a stack trace, and the whole of it would bury the one
 * fact that matters (that the server is not reachable).
 */
export async function synthesize(text, settings, fetchImpl = fetch) {
  const base = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: `TTS base URL is not http(s): ${JSON.stringify(settings.baseUrl)}` };
  }
  const url = `${base}/audio/speech`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        input: text,
        voice: settings.voice,
        response_format: settings.format,
        speed: settings.speed
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `TTS server answered ${res.status}: ${body.slice(0, 200) || '(empty body)'}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'TTS server returned no audio' };
    // A RIFF/WAVE header is the cheapest first rejection — some misconfigured
    // servers answer 200 with JSON or an HTML page — but it is NOT proof that
    // winsound will accept the file. The header of a streaming WAV is well
    // formed and its sizes are not, so the chunks get walked too, and a file
    // whose lengths are sentinels is REPAIRED rather than refused: the audio is
    // real, and the point of this script is to speak it.
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, error: 'TTS server did not return a WAV (missing RIFF/WAVE header)' };
    }
    const info = inspectWav(buf);
    if (!info.ok) return { ok: false, error: `TTS server returned an unplayable WAV: ${info.error}` };
    const audio = info.needsRepair ? repairWav(buf, info) : buf;
    return { ok: true, audio, repaired: info.needsRepair };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── the queue ───────────────────────────────────────────────────────────────

/** Envelope filenames are `.json`; the three subdirs are ignored by `pending()`. */
function isEnvelopeFile(name) {
  return name.endsWith('.json') && !name.startsWith('.');
}

/** Every envelope waiting to be spoken, oldest first by filename. */
export function pending(outbox) {
  let names;
  try {
    names = readdirSync(outbox);
  } catch {
    return [];
  }
  return names.filter(isEnvelopeFile).sort();
}

/**
 * Speak one envelope, moving it to `.done/` or `.failed/` afterwards.
 *
 * The move is the last thing that happens and it always happens: an envelope
 * that vanishes without a trace is a message the user was expecting and never
 * heard, with no evidence it ever existed.
 */
export async function flushOne(outbox, name, { userData, fetchImpl, platform } = {}) {
  const src = join(outbox, name);
  let env;
  try {
    env = JSON.parse(readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    const to = join(outbox, '.failed');
    mkdirSync(to, { recursive: true });
    renameSync(src, join(to, name));
    return { ok: false, name, error: `envelope is not valid JSON: ${e.message}` };
  }

  const check = validateEnvelope(env);
  if (!check.ok) {
    const to = join(outbox, '.failed');
    mkdirSync(to, { recursive: true });
    renameSync(src, join(to, name));
    return { ok: false, name, error: check.problems.join('; ') };
  }

  const settings = resolveTtsSettings(readConfig(userData), { voice: env.voice });
  const spoken = normalizeSpoken(env.text);
  const syn = await synthesize(spoken, settings, fetchImpl);
  if (!syn.ok) {
    const to = join(outbox, '.failed');
    mkdirSync(to, { recursive: true });
    renameSync(src, join(to, name));
    return { ok: false, name, error: syn.error };
  }

  const wav = join(tmpdir(), `md-voice-${randomUUID().slice(0, 8)}.wav`);
  try {
    writeFileSync(wav, syn.audio);
    const played = playWavSync(wav, platform);
    if (!played.ok) {
      // A platform with no playback implementation leaves the envelope where it
      // is: it was not spoken, but nothing failed either, and the next drainer
      // (or the next run on Windows) must still find it. Everything else — a
      // missing clip, a refused PlaySound, an unplayable file — is a real
      // failure of THIS message and goes to `.failed/`, which is a move, never a
      // delete.
      if (played.queued) return { ok: false, name, queued: true, error: played.error };
      const to = join(outbox, '.failed');
      mkdirSync(to, { recursive: true });
      renameSync(src, join(to, name));
      return { ok: false, name, error: played.error };
    }
    const to = join(outbox, '.done');
    mkdirSync(to, { recursive: true });
    renameSync(src, join(to, name));
    return { ok: true, name, chars: spoken.length };
  } finally {
    try { unlinkSync(wav); } catch { /* best effort */ }
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `voice-outbox — queue and play a spoken message for Munder Difflin

  --write "text"     queue a message (id auto-generated) and print its id
  --text "text"      same, as an explicit queueing call
  --check "text"     report spoken-text problems WITHOUT queueing
  --check-file f     check the text in a file
  --flush            speak everything queued, oldest first
  --list             list what is queued, with its state
  --outbox <dir>     override the queue directory

Reads the TTS URL, model, voice and speed from the app's config.json, so a
message sounds like the voice chosen in Settings → Voice.
`;

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const userData = resolveUserData();
  const outbox = arg('--outbox') || outboxDir(userData);
  mkdirSync(outbox, { recursive: true });

  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  const write = arg('--write') ?? arg('--text');
  if (write !== null) {
    const report = checkSpokenText(write);
    if (report.blocking.length) {
      // Refusing here is the point: a message with a file path in it is worse
      // than no message, because the user hears something and believes it.
      process.stderr.write('refusing to queue — fix these first:\n');
      for (const f of report.blocking) process.stderr.write(`  [${f.code}] ${f.detail}\n`);
      return 2;
    }
    for (const f of report.findings) {
      if (!report.blocking.includes(f)) process.stderr.write(`  note [${f.code}] ${f.detail}\n`);
    }
    const settings = resolveTtsSettings(readConfig(userData));
    if (settings.backend !== 'local-tts') {
      process.stderr.write(
        `note: the voice backend is "${settings.backend}", not "local-tts". In that mode Michael ` +
        'speaks messages himself — send this one to god\'s inbox instead, or nothing will be heard twice.\n'
      );
    }
    const id = `msg-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const env = { v: 1, id, text: normalizeSpoken(write), createdAt: new Date().toISOString() };
    // Write-then-rename: a reader must never see a half-written envelope.
    const tmp = join(outbox, `.${id}.tmp`);
    writeFileSync(tmp, JSON.stringify(env, null, 2), 'utf8');
    renameSync(tmp, join(outbox, `${id}.json`));
    process.stdout.write(`${join(outbox, `${id}.json`)}\n`);
    return 0;
  }

  const checkFile = arg('--check-file');
  if (checkFile !== null) {
    const report = checkSpokenText(readFileSync(checkFile, 'utf8'));
    if (report.findings.length === 0) {
      process.stdout.write('ok\n');
      return 0;
    }
    for (const f of report.findings) {
      const level = report.blocking.includes(f) ? 'BLOCK' : 'note';
      process.stdout.write(`${level} [${f.code}] ${f.detail}\n`);
    }
    return report.ok ? 0 : 2;
  }

  if (arg('--check') !== null) {
    const report = checkSpokenText(arg('--check'));
    for (const f of report.findings) {
      const level = report.blocking.includes(f) ? 'BLOCK' : 'note';
      process.stdout.write(`${level} [${f.code}] ${f.detail}\n`);
    }
    if (report.findings.length === 0) process.stdout.write('ok\n');
    return report.ok ? 0 : 2;
  }

  if (argv.includes('--list')) {
    const queued = pending(outbox);
    if (!queued.length) {
      process.stdout.write('(empty)\n');
      return 0;
    }
    for (const n of queued) {
      let note = '';
      try {
        const e = JSON.parse(readFileSync(join(outbox, n), 'utf8'));
        const v = validateEnvelope(e);
        note = v.ok ? `${e.text.length} chars` : `INVALID: ${v.problems[0]}`;
      } catch (err) {
        note = `unreadable: ${err.message}`;
      }
      process.stdout.write(`${n}  ${note}\n`);
    }
    return 0;
  }

  if (argv.includes('--flush')) {
    const waiting = pending(outbox);
    if (!waiting.length) {
      process.stdout.write('nothing queued\n');
      return 0;
    }
    let failed = 0;
    let queued = 0;
    for (const n of waiting) {
      const r = await flushOne(outbox, n, { userData, platform: process.platform });
      if (r.ok) process.stdout.write(`spoke ${r.name} (${r.chars} chars)\n`);
      else if (r.queued) {
        // Not spoken and not failed. Say so in those words, and still fail the
        // exit code: the human must never read this as "the message was
        // delivered" when no audio came out.
        queued++;
        process.stderr.write(`QUEUED NOT SPOKEN ${r.name}: ${r.error}\n`);
      } else {
        failed++;
        process.stderr.write(`FAILED ${r.name}: ${r.error}\n`);
      }
    }
    return (failed || queued) ? 1 : 0;
  }

  process.stderr.write(`unknown option\n\n${USAGE}`);
  return 64;
}

// Only run as a CLI; importing this for its helpers must not speak anything.
//
// The comparison goes through fileURLToPath rather than comparing
// `import.meta.url` to `process.argv[1]` directly. On Windows the URL pathname
// is `/F:/dir/file.mjs` — leading slash, forward slashes — while argv[1] is
// `F:\dir\file.mjs`, so the two are never equal and the guard never fires. The
// failure is silent rather than loud: the script exits 0 having done nothing,
// which looks exactly like a message that was accepted and then lost.
if (process.argv[1]) {
  let self = '';
  try { self = fileURLToPath(import.meta.url); } catch { self = import.meta.url; }
  if (resolve(process.argv[1]) === resolve(self)) {
    main(process.argv.slice(2))
      .then((code) => { process.exitCode = code; })
      .catch((e) => {
        process.stderr.write(`voice-outbox crashed: ${e?.message || e}\n`);
        process.exitCode = 1;
      });
  }
}
