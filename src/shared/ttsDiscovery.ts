/**
 * Realtime Michael — WHAT the local TTS server can actually do, discovered at
 * runtime instead of guessed in code.
 *
 * WHY THIS EXISTS
 *
 * The list of TTS models used to be two constants in this file's sibling:
 * `TTS_MODELS = ['tts-1', 'tts-1-hd']`. That was true of openedai-speech and
 * became false the moment a different server was pointed at — Kokoro serves
 * four models (`tts-1`, `tts-1-hd`, `kokoro`, `gpt-4o-mini-tts`) and 72 voices,
 * and its own default voice is `af_heart`, which appears in no list anyone can
 * write down ahead of time. A picker built from a hardcoded array cannot show a
 * model the app has never heard of, and every server that ships more than two
 * models makes that array wrong.
 *
 * So the server is asked. Two endpoints, both optional, both part of what a
 * "capable" OpenAI-compatible TTS server tends to expose:
 *
 *   GET <base>/models          — the OpenAI list. Widely implemented.
 *   GET <base>/audio/voices    — a Kokoro/voice-clone extension. NOT standard:
 *                                openedai-speech does not serve it at all.
 *
 * Which is exactly why every function here DEGRADES rather than fails. A server
 * that serves neither is still a perfectly good TTS server, and the honest
 * answer for it is a free-text field with the known ids offered as suggestions
 * — not an empty dropdown the user cannot escape.
 *
 * Pure + dependency-free so the renderer can use it without importing main.
 */

/** One model the server reports. */
export interface TtsModelInfo {
  id: string;
}

/**
 * One voice the server reports.
 *
 * The quality fields are OPTIONAL and carry the server's own vocabulary, not
 * ours: Kokoro returns `overall_grade` like "A-" and a training duration, and
 * openedai-speech returns nothing of the kind. They are shown when present and
 * hidden when not, rather than mapped onto a scale we would have invented.
 */
export interface TtsVoiceInfo {
  id: string;
  /** Two-letter prefix from the id, e.g. `af` for an American-English voice. */
  lang?: string;
  /** The server's own grade, verbatim ("A-", "B", "C+"). */
  grade?: string;
}

/** What the server reported, and how much of it to trust. */
export interface VoiceDiscovery {
  models: TtsModelInfo[];
  voices: TtsVoiceInfo[];
  /** True when the models came from the server rather than from a fallback. */
  modelsFromServer: boolean;
  /** True when the voices came from the server rather than from a fallback. */
  voicesFromServer: boolean;
  /** Languages present in the voice list, for a filter. Sorted, deduped. */
  languages: string[];
  /** A short note when a lookup failed, for the Settings line. */
  note?: string;
}

/**
 * Known-good ids, offered as suggestions when the server will not say.
 *
 * Deliberately SHORT, and deliberately only ids that are real somewhere:
 * `tts-1` / `tts-1-hd` (openedai-speech and most clones), `kokoro`
 * (Kokoro-FastAPI), `gpt-4o-mini-tts` (OpenAI's own cheap tier). This is a
 * hint, never a picker — the field stays free text.
 */
export const KNOWN_TTS_MODELS: readonly string[] = [
  'tts-1',
  'tts-1-hd',
  'kokoro',
  'gpt-4o-mini-tts'
];

/** The OpenAI voice names, which several servers map as aliases. Also a hint,
 *  never a closed list: a Kokoro voice id is not in here and must be typable. */
export const KNOWN_TTS_VOICES: readonly string[] = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer'
];

/**
 * The two-letter language prefixes Kokoro and friends use, decoded.
 *
 * The prefixes are NOT a standard and NOT complete — `af` is American female,
 * `bf` British female, `zf`/`zm` are the Chinese set. The value here is only
 * ever shown as a label next to a voice, so a wrong-but-harmless reading beats
 * showing raw codes to someone choosing a voice. Anything not listed is passed
 * through untouched, which is why this is a lookup and not an enum.
 */
const LANG_LABELS: Record<string, string> = {
  af: 'English (US)',
  am: 'English (US)',
  bf: 'English (UK)',
  bm: 'English (UK)',
  jf: 'Japanese',
  jm: 'Japanese',
  zf: 'Chinese',
  zm: 'Chinese',
  ef: 'Spanish',
  em: 'Spanish',
  hf: 'Hindi',
  hm: 'Hindi',
  pf: 'French',
  pm: 'French',
  im: 'Italian',
  if: 'Italian'
};

/** A readable label for a two-letter voice prefix, or the prefix itself. */
export function languageLabel(prefix: string): string {
  const key = (prefix || '').toLowerCase();
  return LANG_LABELS[key] || (key ? key.toUpperCase() : '?');
}

/** The two-letter prefix of a voice id, lowercased. '' when there isn't one. */
export function voiceLang(voiceId: string): string {
  const m = /^([a-z]{2})[_-]/i.exec(String(voiceId || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** Normalize whatever shape a `/models` response takes into a flat id list. */
export function parseModels(payload: unknown): string[] {
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown[] })?.data)
      ? (payload as { data: unknown[] }).data
      : [];
  const out: string[] = [];
  for (const r of rows) {
    const id =
      typeof r === 'string'
        ? r
        : typeof (r as { id?: unknown })?.id === 'string'
          ? (r as { id: string }).id
          : typeof (r as { name?: unknown })?.name === 'string'
            ? (r as { name: string }).name
            : '';
    const trimmed = id.trim();
    // Dedupe: a server that lists one id twice (base + alias) would render a
    // duplicate row in the picker, which reads as a bug in the app.
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Normalize whatever shape a `/audio/voices` response takes. */
export function parseVoices(payload: unknown): TtsVoiceInfo[] {
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { voices?: unknown[] })?.voices)
      ? (payload as { voices: unknown[] }).voices
      : Array.isArray((payload as { data?: unknown[] })?.data)
        ? (payload as { data: unknown[] }).data
        : [];
  const out: TtsVoiceInfo[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const v = (r ?? {}) as { id?: unknown; name?: unknown; overall_grade?: unknown; language?: unknown };
    const id = String(v.id ?? v.name ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const lang =
      typeof v.language === 'string' && v.language.trim()
        ? v.language.trim().toLowerCase().slice(0, 2)
        : voiceLang(id);
    const grade =
      typeof v.overall_grade === 'string' && v.overall_grade.trim() ? v.overall_grade.trim() : undefined;
    out.push(grade ? { id, lang, grade } : lang ? { id, lang } : { id });
  }
  return out;
}

/** The distinct languages in a voice list, sorted, so a filter is stable. */
export function languagesOf(voices: readonly TtsVoiceInfo[]): string[] {
  const set = new Set<string>();
  for (const v of voices) if (v.lang) set.add(v.lang);
  return [...set].sort();
}

/**
 * Keep the voice currently configured rather than replacing it.
 *
 * The important case is a voice that WORKS: a server whose voice list is
 * temporarily short — or which does not serve voices at all — must never make
 * the app silently switch the user off a voice they chose. So this only ever
 * FILLS an empty value; it never overwrites one.
 */
export function reconcileVoice(current: string, voices: readonly TtsVoiceInfo[]): string {
  const want = (current ?? '').trim();
  if (want) return want;
  return voices[0]?.id ?? '';
}

/** The same idea for a model, with the known ids as the last resort. */
export function reconcileModel(current: string, models: readonly TtsModelInfo[]): string {
  const want = (current ?? '').trim();
  if (want) return want;
  return models[0]?.id ?? KNOWN_TTS_MODELS[0];
}
