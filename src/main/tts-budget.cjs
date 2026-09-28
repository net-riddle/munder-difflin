'use strict';
/**
 * The synthesis budget: how long the local TTS server is given, as a function of
 * the work asked for. ONE definition, loaded from disk by both routes that speak.
 *
 * WHY A PLAIN .cjs AND NOT A .ts: the voice-outbox script (`resources/skills/
 * md-voice-brief/`, the "Vocal Sender") runs under plain node, and node cannot
 * import TypeScript — measured on node 23.4.0: `ERR_UNKNOWN_FILE_EXTENSION`, and
 * with `--experimental-strip-types` the main module still dies on its own
 * extensionless import. A `.mjs` CAN take a named import from a `.cjs` (also
 * measured), so this shape is the one both sides can load without a bundler.
 *
 * WHY IT IS COPIED INSTEAD OF BUNDLED: `kg-core.cjs` already plays exactly this
 * role — `knowledge.ts` requires it, `tools/copy-main-assets.cjs` copies it to
 * `out/main/`, and the runtime path is chosen dev vs packaged. Importing a `.cjs`
 * statically and letting the bundler inline it has no precedent in this repo and
 * was NOT measured, so this follows the one that is.
 *
 * THE NUMBERS, and where they come from:
 *  - FLOOR 60 s. The same server, driven by the script, took 31.3 s of wall clock
 *    to speak a one-sentence briefing. A two-word line still needs a warm-up.
 *  - PER_CHAR 500 ms. From 197.7 s for 464 characters measured end to end. That
 *    figure INCLUDES playback, so as a synthesis budget it errs generous — the
 *    safe direction, since waiting too long costs a pause and giving up early
 *    costs the user the sentence. It is an UPPER BOUND on synthesis, not an
 *    estimate of it: the split timing duty was never measured.
 *  - CEILING 600 s. Past ten minutes something is wrong that waiting will not fix,
 *    and a message that takes that long to speak is its own defect.
 *
 * A flat 20 s used to live here, and that is what the announcement timeouts were:
 * a single number cannot be right for a generator whose cost grows with the text.
 */

const SPEAK_BUDGET_FLOOR_MS = 60_000;
const SPEAK_BUDGET_PER_CHAR_MS = 500;
const SPEAK_BUDGET_CEILING_MS = 600_000;

/** Whole-message cap on one announcement, same number realtime.ts enforces. */
const MAX_SPEAK_CHARS = 2_000;

/**
 * How long to wait for the local TTS server, for a request of `chars` characters.
 *
 * With the 220-character splitter, a request is one PIECE, not a whole message —
 * so this budget is asked for ~170 s at most in the real flush path, comfortably
 * above the 204.2 s whole-message measurement it was calibrated from.
 */
function speakBudgetMs(chars) {
  const n = Math.max(0, Math.min(MAX_SPEAK_CHARS, Number(chars) || 0));
  const want = SPEAK_BUDGET_FLOOR_MS + SPEAK_BUDGET_PER_CHAR_MS * n;
  return Math.max(SPEAK_BUDGET_FLOOR_MS, Math.min(SPEAK_BUDGET_CEILING_MS, want));
}

module.exports = { speakBudgetMs, MAX_SPEAK_CHARS };
