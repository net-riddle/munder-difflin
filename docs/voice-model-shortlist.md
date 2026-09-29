# A faster voice, and what it costs — the shortlist

**Card:** `task-kelly-082` · **Asked by:** the human · **Status: BLOCKED, the decision is the human's**
**Question asked:** *find a better or faster model, always self-hostable, maximum 6 GB VRAM.*

---

## The line that decides, first

**Nothing on this list is a straight upgrade. Every fast option that speaks Italian gives up
voice cloning, and every option that keeps cloning is slower than we would like.**

There are exactly two shapes of answer, and which one is right depends on one question only:
**does the office have to keep the voice it has today?**

| | keeps the cloned voice | speaks Italian | verdict |
|---|---|---|---|
| **Kokoro-82M** | **NO** | yes (2 voices) | 20x faster, but the office voice is replaced |
| **Chatterbox Multilingual V3** | yes | yes | the best fit if cloning stays |
| **Qwen3-TTS 0.6B** | yes | yes | the fit with the cleanest licence |
| **XTTS-v2 (today)** | yes | yes | slow, and its licence is restricted |

---

## What we measure here, and the one thing I could not measure

**Measured on this machine, from our own receipts** (`~/.munder-difflin/voice-outbox/.done/*.receipt.json`).
This is the only number in the table that is ours:

| message | chars | synthesis | audio played | RTF |
|---|---|---|---|---|
| `godq01` | 570 | **111.1 s** | 43.7 s | **2.54** |
| `blocked01` | 531 | 106.8 s | 40.9 s | 2.61 |
| `81d3ebb0` | 327 | 35.7 s | 22.0 s | 1.62 |
| `a1e03b82` | 101 | 16.9 s | 8.2 s | 2.07 |

**So XTTS-v2 runs at about RTF 2.3–2.6 here**, and the human waited **111 seconds** for the
570-character message. Note the 5.31 RTF quoted from a third-party benchmark is **not our
machine** — ours is about twice as fast as that number, which is why I will not use vendor or
blog figures as if they were ours.

**The gap I have to declare, because it is the honest limit of this report:** *the card forbids
downloads, so I could not run a single candidate here.* **There is no "RTF measured here" for
Kokoro, Chatterbox or Qwen3-TTS.** Every speed figure below is a **published** number, and it is
marked as such. Turning any row into a decision-grade number requires a trial install, which is
a separate card and needs the human's go-ahead.

A second limit: `playMs` is my proxy for audio length and includes player start-up, so the real
RTF is slightly **higher** than 2.54, not lower.

---

## The shortlist, and what each one costs

### 1. Kokoro-82M v1.0 — the fastest by a wide margin, and it changes the voice

- **Italian: yes.** Two voices, `if_sara` (F) and `im_nicola` (M) — the only two out of 54.
- **Licence: Apache 2.0.** Code and weights both open, commercial use allowed.
- **Size: 82M parameters**, peak 1.1–2.6 GB — well inside 6 GB.
- **Speed: published RTF ~0.12**, i.e. ~8x faster than real time, measured on an Apple M4 Pro CPU.
  Against our measured 2.54 that is roughly **20x less waiting**: the 570-character message would
  fall from **111 s of silence to about 5 s**.
- **Clones a voice: NO.** It ships fixed voice packs. This is the cost.
- **Its own model card warns about Italian specifically:** *"Support for non-English languages may
  be absent or thin due to weak G2P and/or lack of training data"*, and most voices *"perform
  worse at the extremes"*, being tuned for 100–200 tokens.

**Read:** the fastest thing on the list, and the only one that is unambiguously safe to licence.
It is also the one that takes the office's voice away, and the one whose author says its Italian
is thin. Fast and honest, but not the same product.

### 2. Chatterbox Multilingual V3 — the best fit if we keep the voice

- **Italian: yes**, and the strongest claim in the list: **CER under 0.20% for Italian** on
  Resemble's own per-language benchmark — the joint-best language alongside German.
- **Clones a voice: yes**, zero-shot from 5–10 seconds of reference.
- **Licence: MIT.** The most permissive of the cloning options.
- **Size: 0.5B.** A **Turbo** variant exists at **350M**, explicitly built for *"Lower Compute and
  VRAM"*, with a 1-step decoder and an ONNX build — the shape that would suit a small container.
- **Speed: faster-than-realtime is claimed, but no RTF figure is published that I could verify.**

**Read:** Italian is a first-class language here, not a supported one, and MIT removes every
licence question. This is the candidate I would trial first **if the voice must stay ours**.

### 3. Qwen3-TTS-12Hz-0.6B — the licence-clean cloning option

- **Italian: yes**, `it` is one of the 10 declared languages, 5M+ hours of training data.
- **Clones a voice: yes**, from **3 seconds**.
- **Licence: Apache 2.0** — code *and* weights, from the technical report.
- **Size: 0.6B** (a 1.7B exists and is not the one to pick here). The 1.7B is measured at
  **~4.8 GB peak VRAM, RTF ~0.40** on an RTX 5080 by a third party; the 0.6B should sit well
  below that, but **I have no measurement of it.**
- **Streaming latency as low as 97 ms**, which is irrelevant to us — we speak whole messages.
- **There is an ONNX export with INT4** (about 4x smaller) that needs no PyTorch at inference,
  which would suit our container better than the reference implementation.

**Read:** the licence is the cleanest of anything that clones, Italian is declared rather than
hoped-for. Slower than Kokoro by a lot, and I cannot promise its Italian sounds like our voice
until someone hears it.

### 4. XTTS-v2 — what we run today, and one thing nobody has said out loud

- Italian, clones, 6 GB, and **RTF 2.54 measured here**.
- **Its licence is the Coqui Public Model License, which is not an open-source licence** and
  carries a non-commercial restriction. Some third-party pages list it as MPL 2.0; the weights
  themselves are CPML.

**Read:** not slow enough to be the emergency, but it is the one option on this list with a
licence restriction attached, and that is worth knowing before we invest in tuning it.

---

## Considered and ruled out, with the reason

| model | why not |
|---|---|
| **F5-TTS** | three disqualifiers: base is EN/ZH with Italian only via community ports; **CC-BY-NC-4.0, non-commercial**; and it declares **6 GB minimum against our 6 GB ceiling** — a minimum that equals the limit is not a plan. |
| **Fish Speech** | CC-BY-NC-SA, non-commercial. |
| **Zonos, Spark-TTS, IndexTTS 2, MegaTTS 3** | listed at 8 GB, over the ceiling. |
| **Orpheus, Sesame CSM, Higgs Audio** | English. |
| **The two local ONNX files (63 and 78 MB)** | already on disk, and already rejected: English, and they do not clone. Their existence is the proof that *"something faster exists"* was never the real question. |
| **Piper** | fixed voices, no cloning, but Italian voices exist and it is tiny. A reasonable floor, not an answer. |

---

## Two things the human should know before choosing

**1. The ceiling is not the bottleneck, so this is not a ceiling decision.** `speakBudgetMs` grants
2.5x what XTTS spends at 464 characters and 6.5x at 101. Nothing here requires touching it.

**2. There is no GPU information in this report, and that may matter more than every number in it.**
The voice server runs in a container I cannot inspect from here, so I do not know whether it has a
GPU at all. If it is CPU-only, VRAM is irrelevant and the whole ranking turns on CPU speed — which
favours Kokoro even more. **This is the first thing worth answering.**

Also already settled, and it constrains any replacement: the server **serialises requests behind a
lock**, so synthesising the three pieces of a message in parallel would gain nothing. Whatever
replaces XTTS has to keep answering one request at a time, and one request must return one wav.

---

## The question, for the human

**Three choices, and only the first is really the decision:**

1. **Must the office keep its own cloned voice?**
   - **Yes** → trial **Chatterbox Multilingual V3** (MIT, Italian CER <0.20%) and **Qwen3-TTS 0.6B**
     (Apache 2.0) side by side. Both need a trial install; neither has an RTF measured here.
   - **No, a good fixed Italian voice is fine** → **Kokoro-82M**, and the 111 s becomes about 5 s.
     The cost is named above: `if_sara` or `im_nicola`, and its author's own warning about thin
     non-English support.
2. **Is there a GPU in the voice container, and is 6 GB a real ceiling on it?** If it is CPU-only,
   say so and this report gets re-ranked on CPU speed alone.
3. **Is a 20x speedup worth replacing the voice the office has today?** That is a product
   judgement, not a technical one, and it is the only genuinely irreversible thing here.

**Nothing is installed, nothing is changed, and no model has been touched.** The next step is a
card per candidate to trial, and it does not start until the human answers.
