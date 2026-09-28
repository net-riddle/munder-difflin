/**
 * Realtime Michael — main-process ephemeral-token mint (card rt-1, Phase 1).
 *
 * The voice orchestrator (OpenAI `gpt-realtime-2`, speech-to-speech over WebRTC)
 * connects from the RENDERER. The renderer must NEVER hold the real OpenAI key, so
 * MAIN owns it: the BYOK key is stored encrypted at rest in `integration-secrets.json`
 * under `apikey:openai` (the same write-only broker the CLI engines use — set via the
 * `providerKey:*` IPC, materialized main-only, never echoed back). On demand MAIN
 * decrypts it ONCE to mint a SHORT-LIVED EPHEMERAL client secret; only that token +
 * a minimal session config cross IPC to the renderer's `RealtimeSession`. The real
 * key is never returned over IPC, never logged.
 *
 * Phase 1 is read-only — this module ONLY mints (no action tools; that's rt-5).
 *
 * It is also the LOCAL TTS BRIDGE. The voice itself is swappable: with
 * `realtimeVoiceBackend: 'openai'` (the default) the Realtime session emits
 * audio and none of the code below runs; with `'local-tts'` the same session
 * emits TEXT and `speak()` renders each piece on an OpenAI-compatible server
 * the user runs (openedai-speech, speaches, Kokoro-FastAPI…). Both paths share
 * this one key: in local mode the OpenAI key still drives the BRAIN (STT, LLM,
 * tools) and only the voice moves off-machine.
 *
 * Branch feat/realtime-michael. See board.md "🎙 REALTIME MICHAEL".
 */
import { ipcMain, app } from 'electron';
import { getSecret, hasSecret } from './integrations';
import { readConfig } from './config';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeTtsBaseUrl,
  normalizeVoiceBackend,
  resolveLocalTtsSettings,
  speechUrl,
  ttsMime,
  type LocalTtsSettings,
  type RealtimeVoiceBackend
} from '../shared/realtimeVoice';

/** Mirrors `providerKeyRef('openai')` in src/main/index.ts (BACKEND_KEY_ENV maps
 *  openai→OPENAI_API_KEY). Inlined as a local const so this module needs no new
 *  export added to index.ts — keeping the index.ts edit to a single registration
 *  line (rt-1 COORD: Oscar also edits index.ts). */
const OPENAI_KEY_REF = 'apikey:openai';

/** GA speech-to-speech model for the voice orchestrator (v0.3.4: bumped to the
 *  July 2026 gpt-realtime-2.1 — 25% p95 latency cut, better interruption handling).
 *  Defined in shared/ and re-exported here: Settings names this model in copy the
 *  user reads, so main and the UI must not be able to disagree about it. */
export { REALTIME_MODEL } from '../shared/realtimePricing';
import { REALTIME_MODEL } from '../shared/realtimePricing';

/** GA ephemeral-secret mint endpoint. If an account/tier still answers the legacy
 *  beta shape, we fall back to /v1/realtime/sessions on a 404 and normalize both
 *  response shapes below. (Live verification is pending the user's real key.) */
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const LEGACY_SESSIONS_URL = 'https://api.openai.com/v1/realtime/sessions';

const MINT_TIMEOUT_MS = 15_000;

// ─── Local TTS bridge (the 'local-tts' voice backend) ────────────────────────

/** XTTS clips past ~30s of audio, and a runaway delta must not become a
 *  multi-megabyte POST. The renderer's splitter caps pieces well under this;
 *  this is the backstop for a direct call. */
const MAX_SPEAK_CHARS = 2_000;
/** Refuse an implausibly large body rather than base64-ing it into an IPC
 *  message: a 15MB clip is already ~4s of XTTS audio, so anything larger is a
 *  misconfigured endpoint (an HTML error page, a directory listing). */
const MAX_SPEAK_BYTES = 15 * 1024 * 1024;
const SPEAK_TIMEOUT_MS = 20_000;

export type SpeakResult =
  | { ok: true; audio: string; mime: string; bytes: number }
  | { ok: false; error: string; code?: string };

/**
 * Append one line to `<userData>/realtime.log`.
 *
 * WHY THIS EXISTS. The renderer swallows almost everything that goes wrong in
 * the voice loop: the SDK reports a refused SDP handshake as
 * `setRemoteDescription`, the DOMException of a step that worked perfectly,
 * and Chromium's DevTools console is not always open when the user is looking
 * at the app. So the one artifact that can be read afterwards — on disk, by
 * whoever is debugging, including from a terminal — did not exist. A voice
 * failure was therefore reproducible only by the person holding the UI.
 *
 * Append-only and tiny. A timestamp per line, because the sequence is the point:
 * `connect failed` followed by nothing is itself information.
 */
function logRealtime(line: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'realtime.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* A log that cannot be written must never break the voice loop. */
  }
}

/** Which voice backend the loop speaks through, resolved off disk. */
export function getVoiceBackend(): RealtimeVoiceBackend {
  return normalizeVoiceBackend(readConfig().realtimeVoiceBackend);
}

/** The local TTS endpoint, defaults filled and normalized. */
export function getLocalTtsSettings(): LocalTtsSettings {
  const cfg = readConfig();
  return resolveLocalTtsSettings({
    baseUrl: cfg.realtimeTtsBaseUrl,
    model: cfg.realtimeTtsModel,
    voice: cfg.realtimeTtsVoice,
    speed: cfg.realtimeTtsSpeed,
    format: cfg.realtimeTtsFormat
  });
}

/** What the renderer needs to know before it opens a session: the backend in
 *  force and, when it is 'local-tts', where to send text. Never any secret. */
export function getVoiceSettings(): { backend: RealtimeVoiceBackend; tts: LocalTtsSettings } {
  return { backend: getVoiceBackend(), tts: getLocalTtsSettings() };
}

/**
 * Turn text into audio on the user's own machine.
 *
 * This is the whole point of the 'local-tts' backend and the reason it lives in
 * MAIN: the renderer is a web page, and an OpenAI-compatible TTS server on
 * localhost sends no CORS headers, so a renderer fetch is blocked before it
 * starts. Main also keeps the endpoint in one place — the renderer asks "say
 * this", it does not get to choose the URL per call.
 *
 * Deliberately sends NO Authorization header: a local TTS server does not want
 * one, and forwarding an OpenAI key to whatever host the user typed is the one
 * way this could leak the BYOK secret.
 */
export async function speak(
  text: string,
  overrides: Partial<LocalTtsSettings> = {}
): Promise<SpeakResult> {
  const raw = (text ?? '').trim();
  if (!raw) return { ok: false, error: 'nothing to say', code: 'empty' };
  const input = raw.length > MAX_SPEAK_CHARS ? raw.slice(0, MAX_SPEAK_CHARS) : raw;

  const settings = resolveLocalTtsSettings({ ...getLocalTtsSettings(), ...overrides });
  const baseUrl = normalizeTtsBaseUrl(settings.baseUrl);
  if (!baseUrl) {
    return { ok: false, error: 'local TTS base URL is not set or not an http(s) URL', code: 'bad_url' };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SPEAK_TIMEOUT_MS);
  try {
    const r = await fetch(speechUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        input,
        voice: settings.voice,
        response_format: settings.format,
        speed: settings.speed
      }),
      signal: ac.signal
    });

    if (!r.ok) {
      const text2 = await r.text().catch(() => '');
      const msg = text2 ? text2.slice(0, 200) : `HTTP ${r.status}`;
      return { ok: false, error: `TTS request failed (${r.status}): ${msg}`, code: 'tts_failed' };
    }

    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'TTS server returned no audio', code: 'no_audio' };
    if (buf.length > MAX_SPEAK_BYTES) {
      return { ok: false, error: 'TTS response too large to play', code: 'too_large' };
    }
    return { ok: true, audio: buf.toString('base64'), mime: ttsMime(settings.format), bytes: buf.length };
  } catch (e) {
    const err =
      e instanceof Error ? (e.name === 'AbortError' ? 'TTS request timed out' : e.message) : String(e);
    return { ok: false, error: err, code: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Settings → "Test voice": synthesize a fixed line so the user hears the
 *  result instead of trusting a status line. `overrides` lets the button test
 *  the values currently TYPED, before they are saved. */
export async function testSpeak(overrides: Partial<LocalTtsSettings> = {}): Promise<
  { ok: boolean; error?: string; bytes?: number }
> {
  const res = await speak('Voice check. Munder Difflin is listening.', overrides);
  return res.ok ? { ok: true, bytes: res.bytes } : { ok: false, error: res.error };
}

export type MintResult =
  | { ok: true; token: string; expiresAt: number | null; sessionConfig: { model: string } }
  | { ok: false; error: string; code?: string };

/** Whether a BYOK OpenAI key is stored (presence only — no decryption). Gates the
 *  Realtime Michael voice toggle in the renderer, the way `hasGroqKey` gates the
 *  Free Flow mic button. */
export function hasOpenAiKey(): boolean {
  return hasSecret(OPENAI_KEY_REF);
}

/** Mint a short-lived ephemeral client secret for a realtime WebRTC session. The
 *  real OpenAI key is decrypted MAIN-ONLY here and is NEVER part of the result. */
export async function mintRealtimeToken(model: string = REALTIME_MODEL): Promise<MintResult> {
  const key = getSecret(OPENAI_KEY_REF);
  if (!key) {
    return { ok: false, error: 'no OpenAI API key set — add one in Settings → Voice', code: 'no_key' };
  }

  const post = async (url: string, body: unknown) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MINT_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      const text = await r.text();
      let json: Record<string, unknown> | undefined;
      try { json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined; } catch { /* non-JSON body */ }
      return { status: r.status, ok: r.ok, json, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // GA shape first: { session: { type, model } } → { value, expires_at, ... }.
    let res = await post(CLIENT_SECRETS_URL, { session: { type: 'realtime', model } });
    // Older accounts: fall back to the legacy sessions endpoint shape.
    if (res.status === 404) res = await post(LEGACY_SESSIONS_URL, { model });

    if (!res.ok) {
      const errObj = res.json?.error as { message?: unknown } | undefined;
      const msg =
        (typeof errObj?.message === 'string' && errObj.message) ||
        (res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`);
      return { ok: false, error: `token mint failed (${res.status}): ${msg}`, code: 'mint_failed' };
    }

    // Normalize across GA ({ value }) and legacy ({ client_secret: { value } }) shapes.
    const clientSecret = res.json?.client_secret as { value?: unknown; expires_at?: unknown } | undefined;
    const token =
      (typeof res.json?.value === 'string' && (res.json.value as string)) ||
      (typeof clientSecret?.value === 'string' && clientSecret.value) ||
      '';
    if (!token) return { ok: false, error: 'mint returned no ephemeral token', code: 'no_token' };

    const expRaw = res.json?.expires_at ?? clientSecret?.expires_at;
    const expiresAt = typeof expRaw === 'number' ? expRaw : null;

    return { ok: true, token, expiresAt, sessionConfig: { model } };
  } catch (e) {
    const err =
      e instanceof Error ? (e.name === 'AbortError' ? 'token mint timed out' : e.message) : String(e);
    return { ok: false, error: err, code: 'network' };
  }
}

/** Register the renderer-facing realtime IPC. A SINGLE call from index.ts (rather
 *  than per-handler `ipcMain.handle` lines there) keeps the index.ts footprint to
 *  one line — rt-1 COORD note (Oscar also edits index.ts). Neither handler ever
 *  returns the real OpenAI key. */
export function registerRealtimeIpc(): void {
  // Boolean presence only — gates the voice toggle.
  ipcMain.handle('realtime:hasKey', () => hasOpenAiKey());
  // Mint an ephemeral token; returns { token, sessionConfig } only.
  ipcMain.handle('realtime:mintToken', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { model?: unknown };
    const model = typeof p.model === 'string' && p.model.trim() ? p.model.trim() : REALTIME_MODEL;
    return mintRealtimeToken(model);
  });
  // Which voice backend is in force, plus the resolved local-TTS endpoint. The
  // renderer reads this BEFORE opening a session: it decides output modality
  // (audio vs text) and where its speech requests go, so it cannot be a
  // renderer-side guess. No secret is involved on either path.
  ipcMain.handle('realtime:voiceSettings', () => getVoiceSettings());
  // "Say this" — the local TTS bridge. Main owns the endpoint so the renderer
  // can neither be blocked by CORS nor redirect a synthesis call to a host of
  // its choosing. Returns base64 audio + its mime; never returns the URL's
  // credentials because none are sent.
  ipcMain.handle('realtime:speak', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { text?: unknown } & Partial<LocalTtsSettings>;
    const overrides: Partial<LocalTtsSettings> = {};
    if (typeof p.model === 'string' && p.model.trim()) overrides.model = p.model.trim();
    if (typeof p.voice === 'string' && p.voice.trim()) overrides.voice = p.voice.trim();
    if (p.speed != null) overrides.speed = p.speed as number;
    if (typeof p.baseUrl === 'string' && p.baseUrl.trim()) overrides.baseUrl = p.baseUrl.trim();
    if (typeof p.format === 'string') overrides.format = resolveLocalTtsSettings({ format: p.format }).format;
    return speak(typeof p.text === 'string' ? p.text : '', overrides);
  });
  // Settings → "Test voice", with the values currently typed but not yet saved.
  ipcMain.handle('realtime:speakTest', async (_evt, payload: unknown) => {
    const p = (payload ?? {}) as Partial<LocalTtsSettings>;
    return testSpeak(p ?? {});
  });
  // Presence, so the log can distinguish "no key" from "key refused". Never the
  // key, never a fragment of it.
  ipcMain.handle('realtime:log', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { where?: unknown; message?: unknown };
    const where = typeof p.where === 'string' ? p.where.slice(0, 40) : 'unknown';
    const msg = typeof p.message === 'string' ? p.message.slice(0, 600) : '';
    logRealtime(msg ? `${where}: ${msg}` : where);
    return { ok: true };
  });
  // Why the voice loop failed, on disk. The renderer cannot report a WebRTC
  // failure that a human can read later: the SDK names the DOMException rather
  // than the cause, and DevTools is not always open while someone is looking at
  // the app. Main owns the file, so a failure is inspectable from a terminal
  // after the fact. Never a secret — the renderer only holds an ephemeral
  // token, and that is not part of what gets logged.
  ipcMain.handle('realtime:logError', (_evt, payload: unknown) => {
    const p = (payload ?? {}) as { where?: unknown; message?: unknown };
    const where = typeof p.where === 'string' ? p.where.slice(0, 40) : 'unknown';
    const msg = typeof p.message === 'string' ? p.message.slice(0, 600) : String(p);
    logRealtime(`ERROR at ${where}: ${msg}`);
    return { ok: true };
  });
}
