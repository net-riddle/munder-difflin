/**
 * Realtime Michael — WHICH VOICE speaks, and the local-TTS bridge contract.
 *
 * Michael has always spoken with OpenAI's own audio (speech-to-speech over the
 * Realtime API). That is one of two interchangeable VOICE backends, not the
 * product itself: the brain (STT + LLM + the read/action tools) is unchanged
 * either way, only the voice that renders the answer differs.
 *
 *   'openai'     — the shipped path. The Realtime session itself emits audio.
 *   'local-tts'  — the Realtime session emits TEXT and an OpenAI-compatible
 *                  TTS server (openedai-speech, speaches, Kokoro-FastAPI, …)
 *                  synthesises the audio. Useful for people who do not want to
 *                  pay OpenAI for voice output, or who need the answer to stay
 *                  on their machine.
 *
 * Pure + dependency-free (no electron, no main-only imports) so main, the
 * renderer, and the tests can all import it — same reason realtimePricing.ts
 * lives in shared.
 */

/** The two interchangeable voice backends for the Realtime Michael loop. */
export type RealtimeVoiceBackend = 'openai' | 'local-tts';

/** Every backend we accept, in the order the Settings picker shows them. */
export const REALTIME_VOICE_BACKENDS: readonly RealtimeVoiceBackend[] = ['openai', 'local-tts'];

/** Narrow an untrusted value (config on disk, IPC payload) to a backend. */
export function normalizeVoiceBackend(v: unknown): RealtimeVoiceBackend {
  return v === 'local-tts' ? 'local-tts' : 'openai';
}

// ─── Local TTS settings ──────────────────────────────────────────────────────

/** Response containers openedai-speech (and the OpenAI API) accept. */
export const TTS_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const;
export type TtsFormat = (typeof TTS_FORMATS)[number];

/** The model ids openedai-speech maps to its backends: piper (CPU) and XTTS (GPU). */
export const TTS_MODELS = ['tts-1', 'tts-1-hd'] as const;

/** Default endpoint of a stock openedai-speech container. */
export const DEFAULT_TTS_BASE_URL = 'http://localhost:8000/v1';

export interface LocalTtsSettings {
  /** OpenAI-compatible root, ending in /v1. */
  baseUrl: string;
  /** 'tts-1' (piper, CPU) or 'tts-1-hd' (XTTS, voice cloning). */
  model: string;
  /** 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer', or a custom voice. */
  voice: string;
  /** 0.25 – 4.0, as the OpenAI speech API accepts. */
  speed: number;
  format: TtsFormat;
}

export const DEFAULT_LOCAL_TTS: LocalTtsSettings = {
  baseUrl: DEFAULT_TTS_BASE_URL,
  model: 'tts-1',
  voice: 'alloy',
  speed: 1,
  format: 'mp3'
};

/** MIME per format, for the <audio> sink. `pcm` is raw and unplayable without
 *  knowing the sample rate, which is why it is not the default — a user who
 *  picks it gets the bytes, not a broken player. */
const MIME_BY_FORMAT: Record<TtsFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16'
};

export function ttsMime(format: TtsFormat): string {
  return MIME_BY_FORMAT[format] ?? MIME_BY_FORMAT.mp3;
}

/**
 * Accept what a human actually types and land on a usable endpoint: a bare
 * host, a host with a trailing slash, a root that lost its /v1, or the full
 * URL pasted from a README. Returns '' for anything that isn't http(s) so the
 * caller can refuse rather than POST a secret to a typo'd scheme.
 */
export function normalizeTtsBaseUrl(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  // A bare host ("localhost:8000") has no scheme and parses as a protocol-
  // relative URL, so it is normalized to http:// before URL() sees it.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  // Drop query/hash; a TTS endpoint has neither.
  const path = u.pathname.replace(/\/+$/, '');
  // Someone pointing at "http://localhost:8000" means the same server as
  // ".../v1" — the OpenAI client appends /audio/speech under /v1.
  const withV1 = /\/v\d+$/.test(path) ? path : `${path}/v1`;
  return `${u.protocol}//${u.host}${withV1}`;
}

/** The concrete endpoint we POST a synthesis request to. */
export function speechUrl(baseUrl: unknown): string {
  return `${normalizeTtsBaseUrl(baseUrl)}/audio/speech`;
}

export function normalizeTtsFormat(raw: unknown): TtsFormat {
  return (TTS_FORMATS as readonly unknown[]).includes(raw) ? (raw as TtsFormat) : DEFAULT_LOCAL_TTS.format;
}

export function normalizeTtsModel(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || DEFAULT_LOCAL_TTS.model;
}

export function normalizeTtsVoice(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || DEFAULT_LOCAL_TTS.voice;
}

/** Clamp into the 0.25–4.0 window the API documents, so a stray value can't
 *  produce a 400 from the server or a chipmunk from piper. */
export function clampTtsSpeed(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!isFinite(n) || n <= 0) return DEFAULT_LOCAL_TTS.speed;
  return Math.min(4, Math.max(0.25, Math.round(n * 100) / 100));
}

/** Fill a partial (config-on-disk) object with defaults for whatever is absent. */
export function resolveLocalTtsSettings(raw: unknown): LocalTtsSettings {
  const s = (raw ?? {}) as Partial<LocalTtsSettings>;
  return {
    baseUrl: normalizeTtsBaseUrl(s.baseUrl) || DEFAULT_LOCAL_TTS.baseUrl,
    model: normalizeTtsModel(s.model),
    voice: normalizeTtsVoice(s.voice),
    speed: clampTtsSpeed(s.speed),
    format: normalizeTtsFormat(s.format)
  };
}

// ─── Streaming: text → speakable pieces ──────────────────────────────────────

/**
 * Abbreviations that end in a period but do NOT end a sentence. Cutting there
 * would synthesize "Let me check" and "the floor" as two clips with a rising
 * intonation on each — very audible in a voice loop.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'inc', 'ltd', 'co', 'dept', 'est', 'fig', 'approx', 'no', 'vol'
]);

/** Longest a single synthesized clip may get before we force a clause break.
 *  XTTS truncates at 30s of audio; a comma every ~25 words keeps us well under. */
export const MAX_SPEAK_CHARS = 240;

/** Below this, a piece is held back into the buffer: a 2-word clip costs a
 *  round-trip to the TTS server and sounds clipped on its own. */
const MIN_SPEAK_CHARS = 12;

export interface ChunkSplit {
  /** Complete pieces, safe to synthesize right now, in order. */
  chunks: string[];
  /** The trailing fragment — keep it and prepend to the next delta. */
  rest: string;
}

/**
 * Split a GROWING assistant transcript into speakable pieces.
 *
 * The realtime API streams `response.output_text.delta`, so this is called
 * repeatedly with a few words at a time and must be idempotent about
 * boundaries: everything before the last safe cut is returned as a chunk, and
 * the incomplete tail is handed back as `rest` to prepend to the next call.
 * With `final: true` (response.done) the remainder is flushed too, so the last
 * words of a turn are never swallowed.
 *
 * A double space is left at the START of `rest` on purpose: it is the word
 * boundary the cut consumed, and prepending it verbatim keeps "…floor" and
 * "Update" from being glued into "floorUpdate". Trimming happens on the way out.
 */
export function splitSpeakableChunks(buffer: string, final = false): ChunkSplit {
  const text = (buffer ?? '').replace(/\s+/g, ' ');
  if (!text.trim()) return { chunks: [], rest: final ? '' : text };

  const chunks: string[] = [];
  let start = 0;

  const emit = (end: number, from: number): void => {
    const piece = text.slice(from, end).trim();
    if (piece) chunks.push(piece);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Newlines are already folded to spaces above; only terminal punctuation cuts.
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;

    // Consume a run of terminators ("?!", "...") plus trailing quotes/brackets.
    let j = i;
    while (j + 1 < text.length && '.!?…'.includes(text[j + 1])) j++;
    while (j + 1 < text.length && '"\')]»'.includes(text[j + 1])) j++;

    // Not a boundary unless a space (or the very end) follows it.
    const isEnd = j + 1 >= text.length;
    if (!isEnd && text[j + 1] !== ' ') continue;

    // "Dr." / "e.g." — keep going.
    if (ch === '.') {
      const word = text.slice(Math.max(0, i - 12), i).toLowerCase().match(/([a-z.]+)$/)?.[1] ?? '';
      if (ABBREVIATIONS.has(word)) { i = j; continue; }
      // A single initial: "J. R. R." — only two letters or fewer.
      if (/^[a-z]$/.test(word)) { i = j; continue; }
    }

    const end = j + 1;
    if (end - start < MIN_SPEAK_CHARS) continue;
    emit(end, start);
    start = end;
    i = j;
  }

  // A long unpunctuated run (a wall of identifiers, a pasted table) is broken
  // rather than sent whole: XTTS truncates at ~30s of audio, and a cut at the
  // cap mid-word is worse than a breath taken a clause early. Each piece ends
  // on a clause boundary if there is one, else on a WORD boundary — so a
  // fallback cap never says "token1 2" out loud.
  const clipped: string[] = [];
  let cursor = start;
  while (text.length - cursor > MAX_SPEAK_CHARS) {
    const window = text.slice(cursor, cursor + MAX_SPEAK_CHARS);
    const clause = Math.max(
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf(': '),
      window.lastIndexOf(' — ')
    );
    let cut: number;
    if (clause >= 0) cut = clause + 1;
    else {
      const space = window.lastIndexOf(' ');
      // No space at all in the window means one unbreakable token; the cap is
      // then the only option available.
      cut = space > MIN_SPEAK_CHARS ? space + 1 : MAX_SPEAK_CHARS;
    }
    const piece = text.slice(cursor, cursor + cut).trim();
    if (piece) clipped.push(piece);
    cursor += cut;
  }
  chunks.push(...clipped);

  const rest = text.slice(cursor);

  if (final) {
    if (rest.trim()) chunks.push(rest.trim());
    return { chunks, rest: '' };
  }
  // Not final: a short tail is HELD for the next delta, because synthesizing
  // half a clause on its own costs a round-trip and sounds clipped. This is
  // what keeps a 240-char run from being spoken before the turn ends.
  return { chunks, rest };
}
