/**
 * Task-done announcer (renderer half) — say it through the local voice, with no
 * OpenAI in the loop.
 *
 * Main watches the task board and pushes `task:done` here; this speaks the
 * sentence it carries. There is no session, no ephemeral token, no model: the
 * text is a template main already built, and the only thing that turns it into
 * sound is the local TTS server.
 *
 * WHY A SEPARATE PATH, and why main had to grow its own watcher
 *
 * The existing completion relay (rt-12) is downstream of a live RealtimeSession:
 * `trackDispatch` is called only from `execDispatch`, which runs inside the
 * voice loop, and the relay itself reaches Michael by injecting a message into
 * that session. So it needs credits. With an exhausted balance nothing is ever
 * dispatched by voice, so nothing is ever tracked, so nothing is ever said —
 * which is precisely the case where the user most wants to be told a task
 * finished. The trigger here is a card flipping to `done`, which is true
 * whoever dispatched the work and whatever the balance is.
 *
 * Armed ONLY by the Talk button (session.ts connect/disconnect), which in local
 * mode is a pure on/off switch for this announcer — no session, no mic, no
 * model. There is therefore no live-session case to guard against here: the
 * OpenAI path never reaches this code, and the local path never opens a session.
 * That is also why this module does not import session.ts — the check it used to
 * need would have made the two import each other in a cycle.
 *
 * WHY THE SENTENCE IS BUILT HERE AND NOT IN MAIN
 *
 * Main emits only the facts — kind, who, title — because the language the user
 * picked lives in the RENDERER's localStorage and main never sees it. A sentence
 * assembled in main would have to be English forever, so an Italian UI would
 * have been told its own tasks finished in English by its own orchestrator.
 * This module owns the i18next instance, so the framing follows the app language
 * and a language switch takes effect on the very next announcement.
 *
 * Only the FRAMING is translated. The title is text an agent or a person wrote,
 * and translating it would put words in someone's mouth.
 */
import i18n from 'i18next';
import { speakLine, stopLocalVoice } from './localVoice';

let off: (() => void) | null = null;

/**
 * The sentence for one event, in the app's current language.
 *
 * Four shapes per kind, because a card can lack a title, lack an assignee, or
 * lack both, and each gap needs its own wording. Exported so the test can pin
 * the language behaviour without standing up a whole voice loop.
 */
export function announceSentence(evt: {
  kind: 'start' | 'done' | 'blocked';
  who: string;
  title: string;
}): string {
  const who = (evt.who ?? '').trim();
  const title = (evt.title ?? '').trim();
  const t = i18n.t.bind(i18n);
  if (evt.kind === 'start') {
    if (who && title) return t('announce.started', { who, title });
    if (title) return t('announce.startedUnnamed', { title });
    if (who) return t('announce.startedNoTitle', { who });
    return t('announce.startedBare');
  }
  // A blocked card is the one the user has to act on, so it gets its own family
  // rather than borrowing a finished one: "blocked" and "finished" are opposite
  // facts and reusing the wording would tell them the opposite of the truth.
  if (evt.kind === 'blocked') {
    if (who && title) return t('announce.blocked', { who, title });
    if (title) return t('announce.blockedUnnamed', { title });
    if (who) return t('announce.blockedNoTitle', { who });
    return t('announce.blockedBare');
  }
  if (who && title) return t('announce.finished', { who, title });
  if (title) return t('announce.finishedUnnamed', { title });
  if (who) return t('announce.finishedNoTitle', { who });
  return t('announce.finishedBare');
}

/**
 * Speak every finished task. Idempotent: calling it twice does not double the
 * subscription, which matters because a double subscription says the same
 * sentence twice.
 */
export function startTaskAnnouncer(): void {
  if (off) return;
  off = window.cth.onTaskDone?.((evt) => {
    const text = announceSentence(evt).trim();
    if (!text) return;
    // No new-caller check: a notification that arrives while the previous one is
    // still being spoken QUEUES behind it. Interrupting would drop the tail of
    // a sentence mid-word, and the whole point of a local voice is that it is
    // intelligible rather than fast.
    //
    // The outcome is reported, not assumed. The three values are load-bearing:
    // a `cut-short` announcement was NOT heard — the user interrupted, or the
    // clip hit the hard stop — and reporting that as `played` would be the exact
    // false claim this path exists to avoid. A rejection can only mean a waiter
    // threw, and is deliberately not dressed up as a voice failure.
    void speakLine(text).then((outcome) => {
      try {
        window.cth?.taskAnnouncementOutcome?.({
          taskId: evt.taskId,
          kind: evt.kind,
          outcome
        });
      } catch {
        /* reporting the outcome must never break the announcer */
      }
    }, () => { /* see above: not a voice failure */ });
  }) ?? null;
}

/** Stop announcing and release the playback sink. */
export function stopTaskAnnouncer(): void {
  off?.();
  off = null;
  stopLocalVoice();
}
