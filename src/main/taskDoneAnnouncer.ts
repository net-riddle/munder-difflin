/**
 * Task-done announcer — speak a finished task through the LOCAL voice, with no
 * OpenAI involved.
 *
 * WHY THIS EXISTS, and why it is not the completion watcher.
 *
 * `RealtimeCompletionWatcher` (rt-12) already speaks completions, but it only
 * tracks work DISPATCHED BY VOICE MICHAEL — `trackDispatch` has exactly one
 * caller, `execDispatch` in realtimeActions.ts, and that runs inside a live
 * RealtimeSession. So the existing "task finished" notification is downstream of
 * the very thing that costs money: with an exhausted credit balance nothing is
 * ever dispatched by voice, the watcher has nothing tracked, and the
 * announcement never fires. The user asked for the announcement to work WITHOUT
 * OpenAI, which means the trigger has to be independent of the voice session.
 *
 * So this watches the one signal that exists regardless of who dispatched
 * anything: a task card flipping to `done`. No model, no session, no key — a
 * template turns the card into a sentence and the local TTS server says it.
 *
 * Deliberately electron-free and reader-injected, like its sibling, so the
 * detection rule is unit-testable and this file can be reasoned about without
 * running the app.
 */
import type { TaskCard } from './realtimeCompletionWatcher';

/** What a card just did. `start` is a card entering `doing`; `done` is a card
 *  reaching `done`; `blocked` is a card that needs a human. All are transitions,
 *  never states — a card that sits in `doing` for an hour is announced once, on
 *  the way in. */
export type TaskEventKind = 'start' | 'done' | 'blocked';

/**
 * One card observed to have just changed state.
 *
 * STRUCTURED, NOT A SENTENCE. This used to carry a ready-made English
 * `summary` built from a template here, which meant the voice spoke English to
 * a user whose app was in Italian — and there is no way to fix that from this
 * process, because the chosen language lives in the renderer's localStorage and
 * main never sees it. So the sentence is composed in the renderer, which
 * already has every translation loaded. What crosses IPC is only the facts,
 * and only the framing is localized: a task title is text an agent or a person
 * wrote, and translating it would be inventing something nobody said.
 */
export interface TaskDoneEvent {
  taskId: string;
  kind: TaskEventKind;
  /** Friendly agent name when resolvable, else the raw id, else ''. */
  who: string;
  title: string;
  at: number;
}

export interface TaskDoneDeps {
  /** Current task cards. Called each poll; a throwing reader yields []. */
  tasks: () => TaskCard[];
  /** Map an agent id to a friendly name. Optional; falls back to the raw id. */
  nameOf?: (agentId: string) => string | null;
  /** Deliver the event. The only effect this module has. */
  push: (e: TaskDoneEvent) => void;
  /** Master switch, read each poll. False ⇒ the poll is a no-op. */
  enabled: () => boolean;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 5_000;

/** How much of a card title reaches the voice. A notification, not a briefing:
 *  the card stays clickable for the full text, and a minute of speech is not a
 *  notification. Exported so the bound is asserted where it is enforced. */
export const MAX_TITLE = 140;

/** Stop the seen-set from growing without bound over a long session. Well
 *  above any realistic number of tasks in a day; oldest entries go first. */
const MAX_SEEN = 5_000;

const DONE = 'done';
const DOING = 'doing';
const BLOCKED = 'blocked';

/** Is this card in the finished state? Case-insensitive, and tolerant of the
 *  surrounding whitespace a hand-edited tasks.json tends to have. */
export function isDone(card: TaskCard): boolean {
  return (card?.status ?? '').trim().toLowerCase() === DONE;
}

/** Is this card in the in-progress state? Same tolerance as isDone. */
export function isDoing(card: TaskCard): boolean {
  return (card?.status ?? '').trim().toLowerCase() === DOING;
}

/** The status a card is in, normalized. Anything unrecognized reads as '' so it
 *  never matches a start or a finish. */
function statusOf(card: TaskCard): string {
  return (card?.status ?? '').trim().toLowerCase();
}

/** The shape `registry.json` actually has. It is a MAP keyed by agent id —
 *  `{ godId, agents: { "jim-mugp1eoh": { id, name, … } } }` — and not an array.
 *  Both are accepted because the cost of being wrong here is not a crash: the
 *  reader below returns null, the caller falls back to the raw id, and the user
 *  HEARS "jim-mugp1eoh". */
export type AgentNameSource =
  | { agents?: Record<string, { id?: string; name?: string }> | Array<{ id?: string; name?: string }> }
  | null
  | undefined;

/** The friendly name for an agent id, read from a registry. null when unknown.
 *
 *  Exported and tolerant of BOTH shapes on purpose. The bug this fixes was
 *  written here once already: `test/capabilities.test.cjs` carries the note
 *  "registry.json is `{ agents: { <id>: {...} } }`, NOT an array — reading it as
 *  one is the mistake that produced a silent empty answer once already", written
 *  for a DIFFERENT function. The same mistake was then made again, in
 *  `index.ts`, against a `catch` that turned the TypeError into a null — so the
 *  name lookup failed for EVERY card, silently, and the human heard the raw
 *  registry id spoken on every announcement (2026-09-29).
 *
 *  -> A shape assumption with a `catch` around it does not fail: it degrades
 *  into a wrong answer that still looks like an answer. The shape is asserted
 *  by a test against the REAL registry file instead. */
export function agentNameIn(registry: AgentNameSource, id: string): string | null {
  const agents = registry?.agents;
  if (!agents) return null;
  if (Array.isArray(agents)) {
    return agents.find((a) => a?.id === id)?.name ?? null;
  }
  const entry = agents[id];
  const name = entry?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Who is this card about? assignee is the primary field; owner is the
 *  fallback some older cards use. */
export function whoOf(card: TaskCard, nameOf?: (id: string) => string | null): string {
  const id = (card.assignee ?? card.owner ?? '').trim();
  if (!id) return '';
  const named = nameOf?.(id);
  return (named ?? id).trim();
}

/** Titles are trimmed to something a voice can read. The card stays clickable
 *  for the full text; this is a notification, not a briefing. */
function titleOf(card: TaskCard): string {
  return (card.title ?? '').trim().slice(0, MAX_TITLE);
}

/**
 * What a card moving from `prev` to `next` means, or null for no news.
 *
 * Three moves are events, and all are deliberately narrow:
 *    → doing    a start. A card created as `todo` is a plan; `blocked` is a
 *               problem. Neither is work that has begun.
 *    → done     a finish.
 *    → blocked  a card that now needs a human. This was MISSING, and its absence
 *               was the whole point of the gap: the user was told when work
 *               started and when it finished, and stayed silent at the one
 *               moment they are actually needed.
 *
 * A `doing → blocked` card therefore announces TWICE: `start`, then `blocked`.
 * That is deliberate, not a duplicate. The first says work began; the second
 * says a person is required. Different facts, so the second is not a repeat —
 * and the rule this module already states ("a notification that repeats is worse
 * than one that is missed") is about repeating the SAME information. What it
 * must not do is re-announce a card that is still blocked, and `seen` already
 * guarantees that: a transition fires once, however long the card then sits
 * there.
 *
 * Anything else — an assignee being set, a title being edited, a card moving
 * back to `todo` — is silent, because this watcher runs every few seconds and
 * a notification that repeats is worse than one that is missed.
 */
export function transitionTo(prev: string, next: string): TaskEventKind | null {
  if (prev === next) return null;
  if (next === DONE) return 'done';
  if (next === DOING) return 'start';
  if (next === BLOCKED) return 'blocked';
  return null;
}

export class TaskDoneAnnouncer {
  private readonly deps: TaskDoneDeps;
  private readonly pollMs: number;
  /** Last known status per card id, normalized. This is the whole state of the
   *  watcher, and it is what makes "started" expressible at all: a set of
   *  finished ids could not tell a card that has been `doing` since startup
   *  from one that just entered it. */
  private readonly seen = new Map<string, string>();
  /** The first poll is a baseline, not news — see start(). */
  private primed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TaskDoneDeps) {
    this.deps = deps;
    this.pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.timer) return;
    // Prime immediately so launching the app does not announce the entire
    // existing floor — the failure mode of "watch for done" naively written,
    // and one notification per card in flight besides now that starts count.
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Test seam: drop the baseline, so the next poll behaves like the first. */
  reset(): void {
    this.seen.clear();
    this.primed = false;
  }

  poll(): void {
    if (!this.deps.enabled()) return;
    let cards: TaskCard[];
    try {
      cards = this.deps.tasks() ?? [];
    } catch {
      // A reader that throws is a transient fs/parse problem, not a reason to
      // stop announcing. Skipping a poll cannot cause a duplicate, because
      // `seen` only ever moves forward.
      return;
    }
    if (!Array.isArray(cards)) return;

    if (!this.primed) {
      for (const c of cards) this.remember(c);
      this.primed = true;
      return;
    }

    for (const card of cards) {
      if (!card || typeof card.id !== 'string') continue;
      const next = statusOf(card);
      const prev = this.seen.get(card.id);
      // Compare BEFORE remembering: remembering first would make every card
      // look unchanged and nothing would ever be announced.
      this.remember(card);
      if (prev === undefined) continue; // a card that appeared mid-run: no baseline to compare against
      const kind = transitionTo(prev, next);
      if (!kind) continue;
      const who = whoOf(card, this.deps.nameOf);
      try {
        this.deps.push({
          taskId: card.id,
          kind,
          who,
          title: titleOf(card),
          at: Date.now()
        });
      } catch {
        // A failed push must not stop the loop. The status is already recorded,
        // so this transition is not retried — the right trade, since a retry
        // on every poll afterwards is worse than one lost notification.
      }
    }

    this.forgetAbsent(cards);
  }

  /**
   * Drop the ids that are no longer on the board.
   *
   * Without this, a deleted card that later comes back under the same id
   * inherits its old status, so a re-created `doing` card reads as
   * `doing → doing` — no transition, and it never announces its start. Ids are
   * reused in practice (task counters roll per agent), so this is not
   * hypothetical.
   *
   * Deliberately NOT how a card being deleted is handled: a card removed from
   * the board mid-run is not announced, because "this task vanished" is not
   * something this voice should report and the app has its own UI for it.
   */
  private forgetAbsent(cards: TaskCard[]): void {
    const present = new Set<string>();
    for (const c of cards) {
      if (c && typeof c.id === 'string') present.add(c.id);
    }
    for (const id of [...this.seen.keys()]) {
      if (!present.has(id)) this.seen.delete(id);
    }
  }

  private remember(card: TaskCard): void {
    this.seen.set(card.id, statusOf(card));
    if (this.seen.size <= MAX_SEEN) return;
    // Maps iterate in insertion order, so the least recently updated go first.
    const excess = this.seen.size - MAX_SEEN;
    let dropped = 0;
    for (const id of this.seen.keys()) {
      this.seen.delete(id);
      if (++dropped >= excess) break;
    }
  }
}
