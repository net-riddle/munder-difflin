/**
 * The LOCAL VOICE — text to sound on the user's own machine, with no OpenAI.
 *
 * The session does not exist in this mode: there is no model, no microphone, no
 * token. The only thing this module does is take a line of text and play it
 * through an OpenAI-compatible TTS server the user runs:
 *
 *   text ──▶ split ──▶ queue ──▶ main (POST /v1/audio/speech) ──▶ <audio>
 *            (sentences)           (base64 audio)
 *
 * Sentence-by-sentence because a notification has to start before it is
 * finished: piper is fast and a whole paragraph is a perceptible wait before
 * the first word. The queue is strictly serial, because two clips cannot share
 * one <audio> element without cutting the first off mid-word.
 *
 * Nothing here knows the endpoint: it asks MAIN to say a line
 * (`realtimeSpeak`) and main owns the URL. That keeps CORS out of the picture
 * and stops the renderer from choosing where audio requests go.
 */
import { splitSpeakableChunks } from '@shared/realtimeVoice';

export type LocalVoiceEvent =
  /** Playback started (queue non-empty). */
  | { type: 'speaking' }
  /** Queue drained — back to listening. */
  | { type: 'idle' }
  /** A synthesis call failed; the queue keeps going with the next line. */
  | { type: 'error'; error: string }
  /** Playback was cut short. */
  | { type: 'interrupted' };

type Listener = (ev: LocalVoiceEvent) => void;
const listeners = new Set<Listener>();

function emit(ev: LocalVoiceEvent): void {
  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      /* a listener must never break the voice loop */
    }
  }
}

/**
 * What became of one spoken line. THREE values, not two, and the third is why
 * this type exists at all.
 *
 *   played     the media element reached its own `ended`: the user heard all of it.
 *   cut-short  playback began and did not finish — barge-in, the generation
 *              guard, or the hard-stop watchdog. **NOT heard.** Saying so is the
 *              entire point: count a cut announcement as spoken and we tell the
 *              user they heard something at the exact moment they were not
 *              listening, which is the failure the human described.
 *   failed     it never became audible: synthesis error, decode failure, or
 *              autoplay refused.
 *
 * A line is split into sentence clips, so a line can play half and then be cut.
 * The line's outcome is the WORST of its clips, never the last one.
 */
export type SpeakOutcome = 'played' | 'cut-short' | 'failed';

const SEVERITY: Record<SpeakOutcome, number> = { played: 0, 'cut-short': 1, failed: 2 };

/** The worse of two outcomes: a line is only `played` if every clip was. */
export function worseOutcome(a: SpeakOutcome, b: SpeakOutcome): SpeakOutcome {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/** Subscribe to the queue's lifecycle (speaking / idle / error / interrupted).
 *  Returns an unsubscribe. Listeners must never throw — one that does would
 *  otherwise take the voice loop down with it, so they are isolated. */
export function onLocalVoiceActivity(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Lines waiting to be synthesized, in order. */
let queue: string[] = [];
/** The <audio> element TTS clips play through (chosen speaker sink). */
let audioEl: HTMLAudioElement | null = null;
let pumping = false;
/** Callers waiting to be told what became of the line they asked to speak.
 *  Drained by the pump run that plays it — including a run that was already in
 *  flight, because their chunks are already in its queue. */
const outcomeWaiters: Array<(o: SpeakOutcome) => void> = [];
/** Bumped on every cancel/teardown so an in-flight playback loop can tell that
 *  the session it belonged to is gone. */
let generation = 0;

/** Longest we will wait for one clip to finish before moving on. A wedged
 *  decode must not strand the queue forever — the mic stays live either way. */
const CLIP_HARD_STOP_MS = 60_000;

/** Route a clip to the user's chosen speaker. `setSinkId` is Chromium-only
 *  and absent from some lib.dom typings, so feature-detect and cast narrowly. */
async function applySink(el: HTMLAudioElement, deviceId: string | null): Promise<void> {
  const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sink.setSinkId !== 'function') return;
  try {
    await sink.setSinkId(deviceId ?? '');
  } catch {
    /* device gone or unsupported — stay on the system default */
  }
}

/** The speaker the queue last used, so a lazily-created sink lands on the same
 *  device the user picked instead of silently reverting to the system default. */
let lastDeviceId: string | null = null;

/**
 * The playback sink, created on first use if nobody pre-armed it.
 *
 * Two callers exist and only one of them can pre-arm: the voice SESSION calls
 * startLocalVoice() at connect, but the task-done ANNOUNCER has no session at
 * all — it just needs to say a sentence. Without this, a `pump()` that finds a
 * null sink skips the clip and the announcement is silently dropped, which
 * looks exactly like a broken TTS server.
 */
function ensureSink(): HTMLAudioElement | null {
  if (audioEl) return audioEl;
  try {
    const el = new Audio();
    el.autoplay = true;
    el.preload = 'auto';
    audioEl = el;
    void applySink(el, lastDeviceId);
    return el;
  } catch {
    return null;
  }
}

/** Prepare the playback sink for a session. Call BEFORE the first clip so the
 *  user hears the greeting on the speaker they picked. */
export function startLocalVoice(deviceId: string | null): void {
  stopLocalVoice();
  const el = new Audio();
  el.autoplay = true;
  el.preload = 'auto';
  audioEl = el;
  lastDeviceId = deviceId;
  void applySink(el, deviceId);
}

/** Change the speaker mid-session (device picker, rt-8). */
export function setLocalVoiceOutputDevice(deviceId: string | null): void {
  lastDeviceId = deviceId;
  if (audioEl) void applySink(audioEl, deviceId);
}

/** True while anything is queued, being synthesized, or playing. */
export function isLocalVoiceBusy(): boolean {
  return pumping || queue.length > 0;
}

/** Force the clip that is playing RIGHT NOW to release itself and settle.
 *
 * WHY THIS EXISTS — a leak and a dead queue, from one missing capability.
 * playClip's promise settles only on the media element's own 'ended' / 'error'
 * events, or on a 60s watchdog. Pausing an element fires NONE of them. So
 * interrupting mid-sentence left the promise pending forever, which meant:
 *
 *   - the object URL was never revoked, pinning the clip's bytes for the life of
 *     the window (a backlog of notifications grows it without bound), and
 *   - `pumping` stayed true, so every later speakLine() was a silent no-op.
 *     One interruption bricked the voice until the app was restarted.
 *
 * The pending clip registers its own cleanup here, so a cancel is a call rather
 * than a hope that an event arrives.
 */
let cancelActiveClip: (() => void) | null = null;

/** Play one clip and resolve with what happened to it. Never rejects: a
 *  decode failure must not take the voice loop down with it.
 *
 *  WHY IT REPORTS, AND WHY IT HAS THREE ANSWERS. Every exit below used to call
 *  the same `done()` and resolve `undefined`, which is why `speakLine` could only
 *  return `void`: the process possessed this fact and discarded it. `ended` is
 *  the ONLY evidence that the user heard the whole line. A cancel, the
 *  generation guard and the watchdog all mean the opposite, and `error` means
 *  nothing was audible at all — three genuinely different facts, so three values
 *  rather than a boolean that would have to lie about one of them. */
function playClip(el: HTMLAudioElement, b64: string, mime: string, gen: number): Promise<SpeakOutcome> {
  return new Promise<SpeakOutcome>((resolve) => {
    let settled = false;
    // Declared BEFORE `done` uses it. It used to be declared after, so the
    // decode-failure path — which calls done() early — hit the temporal dead
    // zone and threw a ReferenceError from inside its own catch block, leaving
    // this promise unsettled and the queue permanently stuck.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let url: string | null = null;

    const done = (outcome: SpeakOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      if (cancelActiveClip === release) cancelActiveClip = null;
      // The object URL is revoked HERE, per clip, rather than at teardown: a
      // backlog of notifications would otherwise hold every clip's bytes for the
      // life of the window. Revoking is idempotent per URL and safe to call
      // after the element has finished with it.
      if (url) {
        URL.revokeObjectURL(url);
        url = null;
      }
      resolve(outcome);
    };
    // Named, because they are handed to addEventListener AND removeEventListener
    // and the two must be the same reference or the listener never comes off.
    const onEnded = (): void => done('played');
    const onError = (): void => done('failed');
    // A cancel is barge-in: the user stopped us. Playback had begun and will not
    // finish, which is `cut-short` and emphatically not `played`.
    const release = (): void => done('cut-short');

    // A BLOB, not a `data:` URL. The renderer's Content-Security-Policy
    // declares `media-src 'self' blob: mediastream:` — `data:` is NOT in that
    // list, so a data: source is blocked and the answer is silent with no error
    // anywhere. `blob:` is allowed, and it also avoids base64 round-tripping a
    // few MB back into a string the media stack has to re-parse.
    try {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch {
      // Malformed base64 from the bridge: release and keep the queue going.
      // Nothing was ever audible, so this is `failed`, not a silent `played`.
      done('failed');
      return;
    }

    cancelActiveClip = release;
    timer = setTimeout(() => {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      // The hard stop truncated a clip that had not reached its end, so the user
      // did not hear all of it. `cut-short`, and the conservative reading is the
      // right one: the alternative is claiming more than we know.
      done('cut-short');
    }, CLIP_HARD_STOP_MS);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.src = url;
    // Autoplay can be refused until the user has interacted with the window.
    // The rejection is swallowed: the clip is skipped, the loop continues.
    void el.play().catch(() => done('failed'));
    // A cancel between the click and the play must still stop this clip.
    if (gen !== generation) done('cut-short');
  });
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  const gen = generation;
  emit({ type: 'speaking' });
  // Aggregate over the WHOLE run, not the last clip: a line split into
  // sentences that plays two and is then cut has not been heard, and taking only
  // the final outcome would report it as played.
  let worst: SpeakOutcome = 'played';
  try {
    while (queue.length && gen === generation) {
      const line = queue.shift();
      if (!line) continue;
      const res = await window.cth.realtimeSpeak({ text: line }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e)
      }));
      // A cancel during the synthesis round-trip drops the clip AND the rest of
      // the turn: the user interrupted, so the rest of the sentence is not
      // something they want to hear.
      if (gen !== generation) { queue = []; worst = worseOutcome(worst, 'cut-short'); break; }
      if (!res.ok) {
        // The common failure is the TTS server being down; it has no UI of its
        // own, so it lands in the same on-disk log as the session failures.
        void window.cth.realtimeLogError?.('tts', res.error).catch(() => { /* best-effort */ });
        emit({ type: 'error', error: res.error });
        worst = worseOutcome(worst, 'failed');
        continue;
      }
      // Lazily created when the announcer speaks without a session.
      const el = ensureSink();
      if (!el) { worst = worseOutcome(worst, 'failed'); continue; }
      worst = worseOutcome(worst, await playClip(el, res.audio, res.mime, gen));
    }
  } finally {
    pumping = false;
    if (gen === generation) emit({ type: 'idle' });
    // Everything queued at the end of this run now has an answer, including the
    // ones a barge-in dropped: they were cut short, not played.
    const answer = gen === generation ? worst : worseOutcome(worst, 'cut-short');
    const pending = outcomeWaiters.splice(0, outcomeWaiters.length);
    for (const w of pending) {
      try { w(answer); } catch { /* a waiter must not break the voice loop */ }
    }
  }
}

/** Speak a whole line at once — a completion notice, in practice. Split on
 *  sentences so a long objective is a sequence of clips rather than one
 *  synthesis the user waits through in silence.
 *
 *  IT RETURNS THE OUTCOME. It used to return `void`, which is how a fact the
 *  process already had went missing: `playClip` knew whether the media element
 *  reached `ended`, and the answer stopped at this signature. Existing callers
 *  that ignore the promise are unaffected — nothing about the queueing, the
 *  splitting or the timing changes, only what the caller is now able to know. */
export function speakLine(text: string): Promise<SpeakOutcome> {
  const { chunks } = splitSpeakableChunks(text ?? '', true);
  if (!chunks.length) return Promise.resolve('failed');
  queue.push(...chunks);
  return new Promise<SpeakOutcome>((resolve) => {
    // Registered BEFORE pump() so a run already in flight still settles us: our
    // chunks are in its queue, so it will play them before it finishes.
    outcomeWaiters.push(resolve);
    void pump();
  });
}

/** Cut playback short and drop anything queued. Used when announcements are
 *  switched off. Releasing the playing clip is the load-bearing part: see
 *  cancelActiveClip for what happens if it is left to wait for an event that a
 *  pause never produces. */
export function interruptLocalVoice(): void {
  const wasBusy = isLocalVoiceBusy();
  generation += 1;
  queue = [];
  try {
    audioEl?.pause();
  } catch {
    /* ignore */
  }
  // Force the in-flight clip to settle now, so its bytes are freed and pump()
  // unwinds instead of hanging on a promise that will never resolve.
  cancelActiveClip?.();
  if (!wasBusy) return;
  emit({ type: 'interrupted' });
  if (!pumping) emit({ type: 'idle' });
}

/** Tear the voice down: stop playback, free the current clip, forget the queue,
 *  release the sink. Safe to call when nothing is running. */
export function stopLocalVoice(): void {
  generation += 1;
  queue = [];
  cancelActiveClip?.();
  if (audioEl) {
    try {
      audioEl.pause();
      audioEl.removeAttribute('src');
    } catch {
      /* ignore */
    }
  }
  audioEl = null;
  pumping = false;
}
