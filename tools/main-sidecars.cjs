'use strict';

/**
 * The raw `.cjs` files the main process requires at RUNTIME, and where each one
 * has to land next to the built bundle.
 *
 * WHY THIS IS A SEPARATE FILE
 *
 * These sidecars used to be listed in two places: the `writeBundle` hook in
 * `electron.vite.config.ts`, and `tools/copy-main-assets.cjs`. They drifted.
 * `tts-budget.cjs` was added to the copy script but not to the vite hook, and
 * because `npm run dev` is plain `electron-vite dev` — it never runs
 * `copy:main-assets` — the sidecar was simply absent from `out/main`, so the app
 * died at launch with `Cannot find module './tts-budget.cjs'`. `npm run build`
 * was fine, which is exactly why it survived: the crashing path was the one
 * that skips the script that had the entry.
 *
 * Two lists, one of which only runs in one of two paths, is a bug waiting for
 * the next file. So there is now one list, and both consumers read it. Adding a
 * sidecar is a one-line change that cannot be half-applied.
 *
 * WHY THE SIDECARS EXIST AT ALL: rollup does not bundle a `require()`'d `.cjs`
 * and does not copy it either, so a runtime require of a plain-JS module has to
 * be emitted by hand. They are plain `.cjs` (not `.ts`) because the voice-outbox
 * script requires the budget module from node, which cannot import TypeScript.
 */
module.exports = {
  MAIN_ASSETS: [
    ['src/main/slack-trigger.cjs', 'out/main/slack-trigger.cjs'],
    // Knowledge Graph core (pure-JS, no native deps) — required by knowledge.ts.
    ['src/main/kg-core.cjs', 'out/main/kg-core.cjs'],
    // The synthesis budget, shared with the voice-outbox script: a plain-JS module
    // because node cannot import TypeScript, so the two speaking routes cannot
    // drift into different ceilings. Required by realtime.ts.
    ['src/main/tts-budget.cjs', 'out/main/tts-budget.cjs']
  ]
};
