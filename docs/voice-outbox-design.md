# Voice Brief — design notes

Michael can hand a worker a message to say out loud. This is how that works
today, why it is built this way, and what a future change would replace.

**Status: prepared, not wired into the UI.** The skill and its bridge ship in
`resources/skills/md-voice-brief/`. Nothing in the app was modified, so the
running install is untouched — see *What is not done yet*.

## The request

> Michael should be able to delegate to an agent, through a callable skill, the
> processing of the message to send to the user through audio playback.

Two halves, and they are not the same size.

**The words** are a skill. That part is self-contained: a recipe for text that
survives being heard, which is a different problem from text that reads well.

**The audio** is the hard half, and the reason it needed a design at all.

## The constraint that shaped it

The app can already speak. `main/realtime.ts` has `speak()`, the renderer has a
sentence queue with barge-in, and the user picks an output device in
Settings → Voice. All of it hangs off renderer IPC, because the renderer owns
the `<audio>` element and the device sink.

A worker agent is not the renderer. It runs in a PTY on a CLI, with no bridge
and no access to the app's modules. So either the app learns to watch a
directory, or a script learns to speak.

**The script won**, because the app was running and had work in flight. That is
the whole reason for the shape of this: a seam that works against a live
install, with nothing rebuilt.

## The seam

`<userData>/voice-outbox/<id>.json`, four fields:

```json
{ "v": 1, "id": "msg-…", "text": "…", "createdAt": "…" }
```

Flat and versioned, carrying only the text. An in-app watcher would need
exactly this and nothing more — which is why it is not a job object with
retries and callbacks. **The envelope is the contract, and either side can drain
it.**

Today `resources/skills/md-voice-brief/voice-outbox.mjs` drains it and plays
through winsound. Tomorrow a ~25-line watcher in main drains the same directory
and routes through `speak()`, which would hand the message the app's queue, its
output device, and barge-in for free. **The skill would not change**, and
neither would the agent.

## How the skill reaches the agent

`HiveManager.copyBundledSkills` walks `resources/skills/` recursively and copies
it into every agent's `.claude/skills/` **on every spawn**. So the skill and
its script travel together, and the path an agent uses is the one the app
already advertises for bundled skills:

```
$AGENT_DIR/.claude/skills/md-voice-brief/SKILL.md
$AGENT_DIR/.claude/skills/md-voice-brief/voice-outbox.mjs
```

No reinstall, no config: the next spawned agent has it. Agents already running
get it on their next respawn.

## Two routes, because the voice backends differ

| Backend | Route | Why |
|---|---|---|
| `local-tts` | queue + `--flush` | nobody else is speaking; the script is the voice |
| anything else | outbox message to `god` | Michael is in a live session and speaks it himself |

Queueing in cloud mode would say everything twice. The bridge reads
`realtimeVoiceBackend` and warns; the skill tells the agent which route to take.
A fresh install has no key, so the default is the cloud route — the one where
the script must stay silent.

## The voice matches the app

The bridge reads `realtimeTtsBaseUrl`, `Model`, `Voice` and `Speed` from the
same `config.json` the Settings screen writes, so a message an agent composes
speaks in the voice the user picked — not in a hardcoded one. Verified against
the live config, which currently reads `tts-1-hd` / `sober` / speed 1.

## What the checker refuses, and why it refuses rather than fixes

`--check` reports what will not survive being spoken: file paths (both
separators — a Windows agent writes `src\main\realtime.ts`), URLs, markdown,
bullets, tables, emoji, commit hashes, `TODO`-style markers, nested parens,
ellipses, and anything over 600 characters.

It reports rather than rewrites, because mechanically stripping markdown leaves
broken sentences — "the file  is ready" — which are worse than the marker. The
author fixes it. The only thing normalized automatically is whitespace, where a
change cannot alter meaning.

`--write` re-checks and **refuses to queue** a blocking message. A message with
a file path in it is worse than no message, because the user hears something and
believes it.

## Cost of not touching the app

Stated plainly, because it is the deal:

- playback uses the **OS default device**, not the one chosen in Settings → Voice
- a queued message does **not** join the app's queue, so it can overlap a clip
  Michael is already playing
- playback is **Windows-only** (winsound). On macOS/Linux the envelope is **left
  queued**: not spoken, not filed in `.failed/`, reported as `QUEUED NOT SPOKEN`,
  and the exit code is non-zero. It is deliberately *not* a failure, because
  nothing failed and because `.failed/` is invisible to the in-app watcher below
  — a message parked there would be stranded. It is deliberately *not* a success
  either, because "queued, not spoken" is not "delivered", and a zero exit
  claiming otherwise is the same defect as the system beep.

None of these are bugs to fix in the script. They are what "no app change" costs,
and they disappear when the watcher lands.

## What is not done yet

Nothing in the app was modified, deliberately. Three follow-ups, in the order
worth doing them:

1. **A watcher in main** (`~25 lines`) — drain `<userData>/voice-outbox/` and
   call the existing `speak()`. This is the change that makes the message use
   the chosen device, join the queue, and respect barge-in. The skill and the
   agent's command are unchanged; only the drainer is replaced.
   **And it is not only a drainer: it needs a completion signal.** Main cannot
   know that playback finished, because the `<audio>` element and the queue with
   barge-in belong to the renderer. So the watcher needs an interface the
   renderer answers — a `did-finish` acknowledgement — and not an `await` on a
   call that only means "asked". Until that exists, this route cannot satisfy the
   rule that a message is only reported as delivered once it has been heard, so
   the `SND_NODEFAULT` hard failure above is what carries the guarantee in the
   meantime.
2. **The capability index** — `resources/skills/capabilities/SKILL.md` lists
   the other bundled skills, and a new one belongs there so a worker discovers
   it without being told. Left alone because it is an existing file.
3. **The packaged manifest** — a dev run reads `resources/skills/` from the app
   path, but a packaged build resolves it from `process.resourcesPath`, which
   means the folder has to be listed wherever the build assembles resources.

## Two bugs the tests caught, both worth remembering

- **The path detector only matched `/`.** An agent on Windows writes
  `src\main\realtime.ts`, which sailed straight through — the single most common
  case on the platform this ships on was the one case unchecked.
- **`SND_NODEFAULT` "does not work here" — this entry was WRONG, and it is the
  most expensive mistake in this file's history, so it stays as the corrected
  version.** It used to say: measured with a real TTS clip, `PlaySound(..., 2)`
  returns FALSE and plays nothing, `PlaySound(..., 0)` returns TRUE and plays,
  so the flag "silently disables playback". The measurement was real. The
  conclusion was not: **the FALSE was winsound correctly reporting that the FILE
  was not playable**, and the diagnosis blamed the API instead of the input.
  The file it was handed had `data` and `RIFF` sizes of `0xFFFFFFFF`, so winsound
  could not compute a duration and refused it.

  The three numbers that give it away, all on the same clip:

  | call | result | what it actually was |
  |---|---|---|
  | `PlaySound(path, 0, 2)` | FALSE in 0 ms | the file, honestly refused |
  | `PlaySound(path, 0, 0)` | TRUE in 1490 ms | the **system default sound** |
  | `PlaySound(NULL, 0)` | TRUE in 2 ms | the same beep, called directly |

  A 10.6-second clip "played" in 1490 ms that is 2 ms longer than the system
  beep is not the clip playing. With flag 0 the fallback is the default sound
  and the return is TRUE, so the script printed `spoke` and moved the envelope to
  `.done`: **it reported success having spoken nothing.** `SND_NODEFAULT` is now
  used (flag 2), which keeps the blocking behaviour — `SND_SYNC` is 0 and only
  `SND_ASYNC` would make it non-blocking — and makes an unplayable file a hard
  failure with no substitute.

  Note also what the 30 s of `--flush` really was: TTS synthesis in the
  container, not playback. Had it been playback, a 1.02 s "Ciao." would have
  taken 30 s.

A third, found by the end-to-end run rather than by a test: the CLI entry guard
compared `process.argv[1]` against `import.meta.url`, which on Windows is
`/F:/…` with forward slashes — so it never matched, and the script exited 0
having done nothing. That is the worst shape a bug can have: it looks exactly
like a message that was accepted and then lost.
