# The voice turn registry, and the semaphore

**What a "turn" is:** one delivery. One message spoken, start to finish, with the
author it carries, how long it took, and which envelope it was.

**Where the registry lives:** nowhere new. It is a **read** of the receipts in
`.done/`, in order. A receipt already records `outcome`, `chars`, `pieceCount`,
`spokenCount`, `startedAt`, `totalMs`, `synthMs`, `playMs`, and — since 097 —
`who`. *A second file recording the same facts would be a second book, and a
second book is contradicted the first time one of the two is written and not the
other.*

## WHEN THE NUMBER BECOMES A NUMBER

**The floor has no history of voices. There is nothing to be a number about yet.**

Measured on 2026-09-29 across the whole floor: **0 receipts**, **0 voice
envelopes**, **0 `.claim` directories**, and **no event type in `log.jsonl` that
says something was spoken** — the log has `message`, `spawn`, `app-start`,
`archive`, `condense-abort`, `tasks`, `drop`, and nothing about audio. So the
honest answer to "how many voices overlapped?" was **"I do not know"**, and
**"I do not know" is not zero.**

The reason is deeper than a missing measurement, and it is worth writing down
because it decided the whole shape: `queueMessage` wrote `{v, id, text,
createdAt}` **with no author**, the `.written/` trace had no author, and the
receipt had **no `who`**. The question "who spoke" had never been written down in
any record. **A register nobody has ever filled in is not an empty register: it is
a register that was never written.**

So the author is recorded once, where the message is born, and the receipt
inherits it.

> **FROM THE FIRST DELIVERY THAT CARRIES A `who` IN ITS RECEIPT FORWARD, overlap
> and silence are counts. BEFORE THAT DATE THEY ARE NOT — they are unknown, and
> they are written as unknown.** A measure that has not been taken, written as if
> it had, is the one error that would not notice it was wrong: not "0 overlaps"
> (a false statement) and not even "0 overlaps observed" (which says we looked and
> saw nothing, when we did not look).

**Nobody should write a count for any period before that first dated receipt
exists.** The date is the receipt's own `finishedAt`, and it is the honest answer
to "since when is this a number and not a hope".

## The three cases, and why the third one is not folded into the others

| case | what happened | what the registry says |
|---|---|---|
| **has spoken** | a delivery with an author | a turn: author, when, how long, which envelope |
| **has never spoken** | no receipt anywhere | `waitedMs: Infinity` — **the quietest of all, and therefore first** |
| **has spoken, with no author** | `--write` from a human is not an agent | a turn with `who: ''` — spoken, and **attributable to nobody** |

The third case is not the first with an empty name and it is not the second. A
message that was spoken and that nobody can be named for is a third fact, and it
is recorded as one. **Attributing a silence to somebody at random is worse than
admitting there is nobody**: a register that invents a name is worse than a
register that admits a hole, because the hole is visible and the false name is
believed. For the same reason the author is read from the **envelope** in a live
claim and never guessed: the claim receipt is written immediately after the
rename, *before the envelope is even read*, because a claim without a receipt is
an envelope no reader can ever find again.

## Fairness: the most silent, not the last in the queue

`chiDeveParlare` is **the agent that has gone longest without being spoken**, and
it is written down rather than left to taste because **implementing it as "the
last one in the queue" is the same defect wearing a rule's clothes**: a loud
agent keeps winning, a quiet one is never reached, and the rule still reads like
fairness. It is the criterion **opposite** to "who has written the most".

A tie between two agents who have never spoken is settled by the order they were
given in, and the comparison is a strict `>` so two `Infinity` can never resolve
themselves. **A tie that silently picks by object order is a rule nobody wrote.**

## The semaphore is one line

```
PARLA   | <who> da <da quanto> (<envelope>) | prossimo: <chi> | in coda: N
IN CODA | N messaggi                       | prossimo: <chi>
LIBERO  | niente in coda                   | prossimo: <chi> | ultimo turno: <chi>
```
plus, when somebody has gone quiet, `| senza voce da: <who> <da quanto>`.

One line, because **one line gets read and a panel gets ignored**. If finding out
whether it is your turn means opening a file, what you have is an archive.

`da quanto` is measured from the claim's **`renewedAt`**, not from `claimedAt`:
`renewedAt` is the last proof of life, so a long message is not reported as longer
than it has been.

**The idle line names the next agent too.** The human asking is asking *"is it my
turn?"*, and the honest answer while nothing is queued is still **which** agent
the queue will reach first. A line that only answered it when there was work
would answer it exactly when it does not matter.

**Silence is reported, never corrected.** An agent past `SILENCE_MS` (**one hour**,
declared, and there is nothing to derive it from yet) is named in the line, and
nothing here stops it from working. *"Prendere il tempo"* and *"non stare fermi"*
are two different rules and one line cannot carry both.

## What the claim is, and what it is not

The claim is **not** fairness — it is the right to speak, one at a time, and it is
owned by `task-jim-093`. The registry and the semaphore **read** it
(`activeClaim`) and never change it: `CLAIM_WINDOW_MS = 55 200` is derived (25,1 s
of worst measured synthesis+playback × the declared 2,2 margin) and renewed **per
piece**, and nothing on this page is allowed to move that number.

The two are one thing seen from two sides: **the claim is who is speaking, the
registry is who has spoken, and the semaphore is the line that joins them.**

## What is still unknown, and is not written as known

- **No delivery has been observed in a running app.** The claim is proven by
  reading the source and by tests; a guard no real case has ever crossed is a
  guard that has never been tried, and those are different things.
- **The per-agent copies of this file are behind the repository's** until the
  harness rewrites them at the next spawn, from `repo → build → bundle → spawn`.
  `test/voice-lane-copies` reports it, and that red is the truth: a green there
  would not mean the speaking lane is the right file.
- **The silence threshold is declared, not derived**, because there is no history
  to derive it from. When there is, it should be measured and the declaration
  retired.
