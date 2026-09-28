---
name: md-voice-brief
version: 1.0.0
description: |
  Compose a short message for the human to HEAR, then have it spoken aloud by
  Michael's local voice. Use when asked to "tell the user", "let them know",
  "say this out loud", "announce", or when a result is worth speaking rather
  than writing — a finished job, a blocker, a decision that needs their
  attention. Composes the words for the ear and queues them; it does NOT
  perform the work. (munder-difflin)
allowed-tools:
  - Read
  - Bash
---

# Voice Brief

Michael can hand you something to say. Your job is **the words**, not the work.

## The one rule

**Say it, don't do it.** You are writing a message for an ear. If the message
would mean you took an action, you have the wrong brief — the dispatch should
have asked for the action, and the result comes back as a separate message.
Never approve, retry, or "helpfully" complete something on the way to speaking.

## Write for the ear, not the screen

A reader sees layout. A listener has none of it. Everything below is invisible
on screen and fatal out loud.

| Never | Because | Instead |
|---|---|---|
| `src/api/Reservation.ts` | read character by character — unusable | "the reservation file" |
| `https://…/pull/42` | URLs have no spoken form | "the pull request" |
| `**bold**`, `` `code` ``, `#` | markup is skipped or pronounced | plain words |
| `- item` lists | become a run-on with no pauses | two or three short sentences |
| `\| table \|` | columns have no sound | "three agents: A, B and C" |
| `TODO`, `FIXME`, `OK?` | written for eyes | say the actual request |
| `2.87` | nobody says "two point eight seven" | "about three" |
| `(nested (parens))` | flatten into noise | a second sentence |

**Length.** One or two sentences. A voice notification is a nudge, not a
briefing — the detail belongs in the message or the card, which they can read.

**Rhythm.** Short clauses. One idea per sentence, and let the punctuation make
the pauses for you. Avoid a subordinate clause hanging off another one; the
listener has no punctuation to re-read.

**Register.** First person, addressed to them. No preamble: not "I have processed
your request" — just the content. If something failed, say what failed and what
you did about it, in that order.

## The three steps

### 1. Write it

Keep the finished text in a variable, or a scratch file. Check it:

```bash
node "$AGENT_DIR/.claude/skills/md-voice-brief/voice-outbox.mjs" --check "your message here"
```

It prints `BLOCK [code] detail` for anything that will not survive being heard,
and `note` for what you may want to tighten. **Fix every `BLOCK` yourself** — do
not rewrite the file to make the checker pass, and do not drop the point to fit
the limit. If the message genuinely needs more than one announcement, say the
important part and let the rest live in the card.

### 2. Queue it

```bash
node "$AGENT_DIR/.claude/skills/md-voice-brief/voice-outbox.mjs" --write "your message here"
```

This re-checks, then writes an envelope to the queue and prints its path. The
message is **not spoken yet**.

### 3. Speak it

```bash
node "$AGENT_DIR/.claude/skills/md-voice-brief/voice-outbox.mjs" --flush
```

Speaks everything queued, oldest first, and moves each envelope to `.done/` — or
to `.failed/` with the reason, if the TTS server was unreachable. **If the flush
fails, say so in your reply.** A message you queued and never confirmed is
indistinguishable from one that was never sent.

`$AGENT_DIR` is already set for you — `echo $AGENT_DIR` if it is not.

## Which route to use

Check the voice backend before queuing, because the two modes are not the same:

```bash
node -e "console.log(require(process.env.MD_USER_DATA||'$APPDATA/munder-difflin'+'/config.json').realtimeVoiceBackend)"
```

- **`local-tts`** — queue and flush, as above. The message is spoken by the
  machine, in the voice they chose in Settings → Voice.
- **anything else (cloud)** — do NOT queue. Michael is in a live voice session
  and will speak it himself, so queueing would say it twice. Write ONE message
  JSON into `$AGENT_DIR/outbox/` with `"to": "god"`, a short `subject`, and your
  finished text as the `body` — the usual way to hand something back, and the
  path that works when the voice is in the cloud.

## What this does not cover

The voice is the machine's default output device, not the one chosen in
Settings → Voice, and a queued message does not join Michael's queue — it can
overlap a clip he is already playing. For anything that must be heard over
another, or on a specific device, queue at a quiet moment rather than on top of
speech.
