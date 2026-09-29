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
 *
 * RECEIPT — the outcome, in a file beside the envelope
 *
 *   <userData>/voice-outbox/.done/<id>.receipt.json
 *
 * What happened to the message: pieces, how many sounded, the outcome and the
 * seconds for EACH piece, and the totals. It is a sibling rather than a field
 * because the envelope is a contract with whatever drains this queue next, and
 * because a receipt written into the spoken text would be an announcement nobody
 * authored. It also carries `finishedAt`, which is not a nicety: `rename`
 * preserves mtime, so every envelope in `.done` still wears its own birth date
 * and the one number that matters — when this was played — was on nobody's disk.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ONE synthesis budget, imported — not copied. This is the whole defect 003
// exists to close, so the import is the fix and the rest of this card is wiring:
// `src/main/realtime.ts` loads the same file, so the app's route and this route
// cannot drift into different ceilings without a test noticing.
//
// It resolves from THIS file's location, which is `resources/skills/md-voice-brief/`
// — three levels below the repo root. That path is only correct for the file where
// it lives: a copy under `agents/<id>/.claude/skills/` has no `src/` above it, and
// the import below is written to FAIL LOUDLY in that case rather than to fall back
// to a local constant. A ceiling nobody can see, in a file nobody reads, on the
// only route the user can hear, is worse than no file at all: it is the absence of
// a ceiling, wearing the costume of one.
import { speakBudgetMs } from '../../../src/main/tts-budget.cjs';

// ─── limits ──────────────────────────────────────────────────────────────────

/** Hard ceiling on one announcement.
 *
 *  This used to be 600, and the reason it was there is gone: the limit existed
 *  because ONE message produced ONE clip, and a long clip was a minute of audio
 *  nobody asked for. A message is now cut into pieces of `MAX_PIECE_CHARS` and
 *  spoken in sequence, so "too long for one clip" is no longer a thing that can
 *  happen — refusing a 700-character message after building a splitter that
 *  handles it in four pieces would be refusing work the system can do.
 *
 *  The number is now about the AMOUNT OF SPEECH, not about clip size, because
 *  something still has to bound it: 2000 characters is about nine pieces, roughly
 *  two and a half minutes. Without a bound, a runaway author could queue a
 *  message that talks for a quarter of an hour, and a notification nobody asked
 *  to receive is its own kind of stuck speaker. The message the user sees says
 *  this, instead of the old wording that implied the length itself was unspeakable.
 */
export const MAX_SPOKEN_CHARS = 2000;

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
    problems.push(`text is ${env.text.length} characters, over the ${MAX_SPOKEN_CHARS}-character ceiling on one message (about ${Math.ceil(env.text.length / MAX_PIECE_CHARS)} pieces)`);
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
    add('too-long', `${t.length} characters, over the ${MAX_SPOKEN_CHARS}-character ceiling on one message — about ${Math.ceil(t.length / MAX_PIECE_CHARS)} pieces, so this is a long briefing rather than an announcement. Cut it, or queue it as several messages`);
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

/**
 * Target length of ONE piece, in characters. `MAX_SPOKEN_CHARS` is the ceiling on
 * the whole message; this is a different thing, the length at which a single clip
 * becomes a long unbroken stretch of speech.
 *
 * The number is a TARGET, not a limit: a piece is never split mid-word, and a
 * single sentence longer than this is still broken up (see `splitForSpeech`).
 */
export const MAX_PIECE_CHARS = 220;

/** Sentence ends: `.`/`!`/`?`/`…` (and CJK equivalents) followed by a space. */
const SENTENCE_END = /([.!?…。！？]+)\s+/g;

/** Weaker boundaries, used only when one sentence is longer than a whole piece. */
const CLAUSE_END = /([,;:—–)\]]+)\s+/g;

/**
 * Cut one oversized unit into pieces of at most `maxChars`, never inside a word.
 *
 * The invariant the caller can rely on: `pieces.join(' ') === unit` for every
 * unit this function is given, and no piece ends mid-word unless the word itself
 * is longer than `maxChars` (in which case there is nowhere else to cut, and a
 * test says so out loud instead of pretending otherwise).
 */
function chopLongUnit(unit, maxChars) {
  if (unit.length <= maxChars) return [unit];
  const out = [];
  let rest = unit;
  while (rest.length > maxChars) {
    // Prefer a clause boundary inside the window, then a space. Both are searched
    // only within `maxChars` so the cut can never land past the target.
    const window = rest.slice(0, maxChars + 1);
    let cut = -1;
    CLAUSE_END.lastIndex = 0;
    for (let m = CLAUSE_END.exec(window); m; m = CLAUSE_END.exec(window)) cut = m.index + m[0].length;
    if (cut <= 0) {
      const sp = window.lastIndexOf(' ');
      if (sp > 0) cut = sp + 1;
    }
    if (cut <= 0) {
      // One word longer than the target: there is no boundary to cut on, so the
      // remainder is emitted whole rather than mangled.
      out.push(rest);
      return out;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/**
 * Split a spoken message into pieces that are each a comfortable stretch of
 * speech, in order, so they can be synthesized and played one after another.
 *
 * The human asked for this: a long message was one clip, and a long clip is
 * all-or-nothing — if it fails the user hears nothing at all, and there is no
 * natural pause to interrupt at.
 *
 * Boundaries, strongest first: sentence end, then clause punctuation, then a
 * word boundary. Never inside a word. A text that is already short enough comes
 * back as a single piece, so the single-message path is untouched.
 */
export function splitForSpeech(text, maxChars = MAX_PIECE_CHARS) {
  const norm = normalizeSpoken(text);
  if (!norm) return [];
  const limit = Math.max(1, Number(maxChars) || MAX_PIECE_CHARS);

  const sentences = [];
  let last = 0;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(norm); m; m = SENTENCE_END.exec(norm)) {
    sentences.push(norm.slice(last, m.index + m[1].length));
    last = m.index + m[0].length;
  }
  if (last < norm.length) sentences.push(norm.slice(last));
  if (sentences.length === 0) sentences.push(norm);

  const units = [];
  for (const s of sentences) {
    const t = s.trim();
    if (t) units.push(...chopLongUnit(t, limit));
  }
  if (units.length === 0) return [];
  if (units.length === 1) return units;

  // Pack whole sentences into pieces without exceeding the target.
  const pieces = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + 1 + u.length > limit) { pieces.push(cur); cur = u; }
    else cur = cur ? `${cur} ${u}` : u;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/**
 * The aggregate verdict for a run of pieces: the WORST of them, never the last.
 *
 * The same rule as a spoken line's outcome (played / cut-short / failed): a
 * message that said its first half and then failed has NOT been delivered, and
 * counting the last piece's success would say it was.
 */
export function aggregateOutcome(results) {
  if (!Array.isArray(results) || results.length === 0) return 'failed';
  if (results.some((r) => !r.ok && !r.queued)) return 'failed';
  if (results.some((r) => r.queued)) return 'queued';
  return 'played';
}

/**
 * Synthesize and play `pieces` in order, one after another, through injected
 * `synth(piece, index)` and `play(synthResult, index)`.
 *
 * A piece that FAILS does not stop the chain: the point of splitting is that a
 * human gets as much of the answer as possible, and stopping at the first
 * failure would rebuild the all-or-nothing clip this exists to break. A piece
 * that is `queued` (no playback implementation on this platform) DOES stop it,
 * because there is nothing to play and continuing would only burn the same
 * failure N more times.
 *
 * TIMING, and why it is split in two rather than reported as one number.
 *
 * Every run of this script used to be timed by a person with a stopwatch, three
 * times, because nothing recorded it: the numbers that exist (31.3 s, 197.7 s,
 * 204.2 s) are a hand measurement each, and the length-based estimate they are
 * checked against is the only estimate there is. So each piece carries `synthMs`
 * and `playMs` separately, and that separation is the whole point: `playMs` is
 * how long the audio was audible, `synthMs` is how long the server took to make
 * it, and only the first of those is time the human was made to wait through
 * silence. One total would hide exactly the thing worth seeing — a piece that
 * spent its time waiting on the server, not being heard.
 *
 * A failed piece is timed too, and split the same way: a piece that failed during
 * synthesis has `playMs: 0` and a synth time worth looking at.
 */
export async function speakPieces(pieces, { synth, play, onPiece, now = () => performance.now() } = {}) {
  const results = [];
  const ms = (from) => Math.max(0, Math.round(now() - from));
  for (let i = 0; i < pieces.length; i++) {
    const t0 = now();
    const syn = await synth(pieces[i], i);
    const tSynth = now();
    if (!syn || !syn.ok) {
      results.push({
        piece: i + 1, of: pieces.length, ok: false, stage: 'synthesize',
        error: (syn && syn.error) || 'synthesis failed',
        synthMs: ms(t0), playMs: 0, ms: ms(t0),
      });
      if (onPiece) onPiece(results[results.length - 1]);
      continue;
    }
    const played = (await play(syn, i)) || {};
    results.push({
      piece: i + 1, of: pieces.length, ok: !!played.ok,
      stage: played.ok ? 'played' : 'playback', error: played.error, queued: !!played.queued,
      synthMs: Math.max(0, Math.round(tSynth - t0)),
      playMs: Math.max(0, Math.round(now() - tSynth)),
      ms: ms(t0),
    });
    if (onPiece) onPiece(results[results.length - 1]);
    if (played.queued) break;
  }
  return { outcome: aggregateOutcome(results), results };
}

/**
 * A duration the way a person says it: milliseconds below a second, tenths above.
 *
 * `84.8 s` next to `84.76 s` is not pedantry, it is that a timing nobody can read
 * is a timing nobody uses. And the sub-second case is not cosmetic either — a
 * piece that reports `0.0 s` is indistinguishable from a piece whose clock never
 * ran, which is a real failure mode of a broken measurement, so a real one is
 * printed in the unit where it is still true.
 */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
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
 *
 * THERE IS A CEILING, and it is the shared one. Before this, `synthesize()` waited
 * on the server for as long as the server liked: the script route had no timeout
 * at all while the app route had one, so the two could disagree about what "long"
 * means and only one of them was on a clock. 064 then multiplied that unbounded
 * wait by the number of pieces, so one stuck server cost N times forever.
 *
 * The budget is asked for the LENGTH OF THE PIECE, not of the message. That is not
 * a detail: with the 220-character splitter a request is one piece, so the number
 * in play is ~170 s at most — comfortably above the 204.2 s whole-message run the
 * policy was calibrated from, and above the 16.9 s a 101-character piece actually
 * took. A timeout has to be wrong in the direction of waiting too long: waiting
 * costs the user a pause, giving up early costs them the sentence.
 *
 * WHAT A TIMEOUT LOOKS LIKE, and it is not optional: a piece that gives up is
 * `stage: 'synthesize', ok: false`, `speakPieces` aggregates the WORST piece, so
 * the envelope lands in `.failed` with the reason and the line says `FAILED`. It
 * cannot print `spoke` and it cannot reach `.done` — that is the user's rule
 * ("wait for delivery AND playback") already encoded in the aggregation, so
 * wiring the error in is all this costs.
 */
export async function synthesize(text, settings, fetchImpl = fetch, budgetMs = speakBudgetMs(text.length)) {
  const base = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: `TTS base URL is not http(s): ${JSON.stringify(settings.baseUrl)}` };
  }
  const url = `${base}/audio/speech`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
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
      }),
      signal: controller.signal
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
    // The elapsed time and the budget are both in the message, and that is the
    // point of it. The old error was the bare string 'TTS request timed out',
    // written at the moment of giving up: with no start time kept, "needed 19.9 s"
    // and "needed 169 s" were the same line, and the first one is indistinguishable
    // from a ceiling that is set wrong.
    const waited = Date.now() - started;
    if (controller.signal.aborted) {
      return { ok: false, error: `TTS request timed out after ${waited}ms (budget ${budgetMs}ms for ${text.length} chars)` };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── the queue ───────────────────────────────────────────────────────────────

/**
 * The receipt suffix: `<id>.receipt.json`, beside the envelope it describes.
 *
 * WHY A SECOND FILE AND NOT A FIELD IN THE ENVELOPE — the requirement is the
 * opposite of what it looks like. An envelope is a contract with whatever drains
 * the queue next: flat, versioned, text plus an optional voice, nothing else
 * (`ENVELOPE` in the header). Writing the outcome into it makes the thing a
 * speaker reads depend on a thing the executor wrote, and a receipt written
 * into `text` is worse than no receipt — the human hears an announcement that
 * says it was 84.8 seconds. So the envelope stays exactly as authored and stays
 * readable, and the evidence lives next to it.
 *
 * WHY IT CANNOT BE `.`-PREFIXED: a dotfile is invisible to `readdirSync` for
 * every reader that filters them, and `.done` is already a dotfile. A receipt
 * named `.<id>.receipt.json` would be exactly as findable as the `.done`
 * directory: not at all. The suffix is spelled out in `isEnvelopeFile` instead,
 * which is the one place that has to agree.
 */
export const RECEIPT_SUFFIX = '.receipt.json';

/** The receipt that belongs to envelope `name`, in the same directory. */
export function receiptName(name) {
  return name.replace(/\.json$/, '') + RECEIPT_SUFFIX;
}

/** Envelope filenames are `.json`; the three subdirs and the receipts are not. */
function isEnvelopeFile(name) {
  return name.endsWith('.json') && !name.startsWith('.') && !name.endsWith(RECEIPT_SUFFIX);
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
 * Write the outcome of one delivery beside its envelope, and never throw.
 *
 * WHY THIS EXISTS, measured: six envelopes went through this script in one
 * evening and every one of them landed in `.done/` byte-identical to what was
 * queued — same four fields, and an mtime equal to its own creation time, because
 * `rename` preserves it. So the only proof anyone had was the console line of the
 * terminal that happened to be running, and it said nothing about which piece
 * played, which failed, or how long it took. A file that cannot say when something
 * happened to it is not evidence of anything; this one can, which is why it
 * carries `finishedAt` rather than trusting its own mtime.
 *
 * Best-effort on purpose. The audio has already been heard by the time this runs,
 * so failing the delivery because the receipt could not be written would turn a
 * recording problem into a delivery problem — and would take the envelope in
 * `.done` back out of `.done`. So the error is returned to the caller and named on
 * the printed line instead.
 */
export function writeReceipt(dir, name, receipt) {
  const path = join(dir, receiptName(name));
  const body = JSON.stringify({ v: 1, envelope: name, ...receipt }, null, 2);
  const tmp = join(dir, `.${receiptName(name)}.tmp`);
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, path, error: `could not write the receipt: ${e.message}` };
  }
}

/**
 * Speak one envelope, moving it to `.done/` or `.failed/` afterwards.
 *
 * The move is the last thing that happens and it always happens: an envelope
 * that vanishes without a trace is a message the user was expecting and never
 * heard, with no evidence it ever existed.
 */
export async function flushOne(outbox, name, { userData, fetchImpl, platform, clock = Date.now, playImpl, budgetMs } = {}) {
  const src = join(outbox, name);
  const startedAt = clock();

  /**
   * Move the envelope and leave a receipt beside it, then report the receipt's
   * own outcome. One place, because a move without a receipt is the state this
   * card exists to remove — if any path can still produce one, the fix is not a
   * fix.
   */
  const deliver = (sub, receipt) => {
    const to = join(outbox, sub);
    mkdirSync(to, { recursive: true });
    renameSync(src, join(to, name));
    const written = writeReceipt(to, name, { ...receipt, finishedAt: new Date(clock()).toISOString() });
    return written;
  };

  let env;
  try {
    env = JSON.parse(readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    const receipt = deliver('.failed', { outcome: 'rejected', stage: 'envelope', error: `envelope is not valid JSON: ${e.message}` });
    return { ok: false, name, outcome: 'rejected', error: `envelope is not valid JSON: ${e.message}`, receipt };
  }

  const check = validateEnvelope(env);
  if (!check.ok) {
    const receipt = deliver('.failed', { outcome: 'rejected', stage: 'envelope', error: check.problems.join('; ') });
    return { ok: false, name, outcome: 'rejected', error: check.problems.join('; '), receipt };
  }

  const settings = resolveTtsSettings(readConfig(userData), { voice: env.voice });
  const spoken = normalizeSpoken(env.text);
  // One envelope, N pieces. The envelope is what the human is owed; the pieces
  // are only how the audio is delivered, so they never become N files.
  const pieces = splitForSpeech(spoken);
  if (pieces.length === 0) {
    const receipt = deliver('.failed', { outcome: 'rejected', stage: 'text', error: 'nothing speakable to say' });
    return { ok: false, name, outcome: 'rejected', error: 'nothing speakable to say', receipt };
  }

  const temps = [];
  // `playImpl` is a seam, not a setting: with it, the `.done` branch — the one
  // the receipt card is actually about — can be exercised without a speaker,
  // which is the only way a receipt written there is ever tested rather than
  // asserted about.
  const play = playImpl || (async (syn) => {
    const wav = join(tmpdir(), `md-voice-${randomUUID().slice(0, 8)}.wav`);
    temps.push(wav);
    writeFileSync(wav, syn.audio);
    return playWavSync(wav, platform);
  });
  const shape = (piece) => ({
    piece: piece.piece, of: piece.of, chars: pieces[piece.piece - 1].length,
    ok: piece.ok, stage: piece.stage, error: piece.error ?? null,
    synthMs: piece.synthMs, playMs: piece.playMs, ms: piece.ms,
  });

  try {
    const { outcome, results } = await speakPieces(pieces, {
      synth: async (piece) => synthesize(piece, settings, fetchImpl, budgetMs),
      play,
    });

    const totalMs = Math.max(0, clock() - startedAt);
    const summary = {
      name, chars: spoken.length, pieces: pieces.length,
      spoken: results.filter((r) => r.ok).length, outcome, results,
      startedAt: new Date(startedAt).toISOString(), totalMs,
      synthMs: results.reduce((a, r) => a + r.synthMs, 0),
      playMs: results.reduce((a, r) => a + r.playMs, 0),
    };
    const receiptBody = {
      outcome, chars: summary.chars, pieceCount: summary.pieces, spokenCount: summary.spoken,
      startedAt: summary.startedAt, totalMs, synthMs: summary.synthMs, playMs: summary.playMs,
      pieces: results.map(shape),
    };

    if (outcome === 'queued') {
      // A platform with no playback implementation leaves the envelope where it
      // is: it was not spoken, but nothing failed either, and the next drainer
      // (or the next run on Windows) must still find it.
      //
      // DELIBERATELY NO RECEIPT IS WRITTEN HERE, and this is the one branch where
      // that is a decision rather than an omission. The queue directory is the
      // INPUT directory: a second consumer is going to read it — the in-app
      // watcher is the next step in the design notes — and every one of those
      // readers expects to find envelopes there. A receipt is evidence of a
      // finished delivery, and this delivery did not finish; the reason is on
      // stderr with a failing exit code, which is where a delivery that did not
      // happen belongs. The summary still carries every field a receipt would.
      const error = results.find((r) => r.queued)?.error;
      return { ...summary, ok: false, queued: true, error, receipt: null };
    }
    if (outcome === 'failed') {
      const error = results.filter((r) => !r.ok).map((r) => `piece ${r.piece}/${r.of}: ${r.error}`).join('; ');
      const receipt = deliver('.failed', { ...receiptBody, error });
      return { ...summary, ok: false, error, receipt };
    }
    const receipt = deliver('.done', receiptBody);
    return { ...summary, ok: true, receipt };
  } finally {
    for (const wav of temps) { try { unlinkSync(wav); } catch { /* best effort */ } }
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

/**
 * The line the drainer prints for one envelope, and where it goes.
 *
 * Extracted because the thing 066 asked for is a WORDING, and a wording that can
 * only be seen by running the whole drainer with a real speaker is a wording
 * nobody will change twice. The counts live here so they cannot be left out of
 * one of the three branches by accident.
 */
export function describeFlush(r) {
  const plural = (k) => `${k} piece${k === 1 ? '' : 's'}`;
  // Seconds, per piece, when there is more than one. One piece has nothing to
  // break down, and a breakdown that restates the total teaches nothing.
  const perPiece = (results) => {
    if (!Array.isArray(results) || results.length < 2) return '';
    return ' [' + results.map((p) => `p${p.piece} ${fmtMs(p.ms)}`).join(', ') + ']';
  };
  const took = (ms) => {
    const s = fmtMs(ms);
    return s ? `, ${s}` : '';
  };
  if (r.ok) {
    return { stream: 'stdout', text: `spoke ${r.name} (${r.chars} chars, ${plural(r.pieces)}${took(r.totalMs)}${perPiece(r.results)})\n` };
  }
  if (r.queued) {
    // Not spoken and not failed. Say so in those words, and still fail the exit
    // code: the human must never read this as "the message was delivered" when
    // no audio came out.
    return { stream: 'stderr', text: `QUEUED NOT SPOKEN ${r.name} (${plural(r.pieces)}, 0 spoken${took(r.totalMs)}${perPiece(r.results)}): ${r.error}\n` };
  }
  // The counts are the point: "2 of 5 spoken" says how much of the answer the
  // human actually got, and `r.error` names WHICH piece failed.
  return { stream: 'stderr', text: `FAILED ${r.name} (${r.spoken} of ${plural(r.pieces)} spoken${took(r.totalMs)}${perPiece(r.results)}): ${r.error}\n` };
}

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
      const d = describeFlush(r);
      if (d.stream === 'stdout') process.stdout.write(d.text);
      else { process.stderr.write(d.text); if (r.queued) queued++; else failed++; }
      // A receipt that could not be written is reported, never swallowed: the
      // whole point of the artifact is that it is the evidence, so losing it
      // quietly would leave the next reader with the exact silence this fixed.
      if (r.receipt && !r.receipt.ok) process.stderr.write(`  note ${r.receipt.error}\n`);
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
