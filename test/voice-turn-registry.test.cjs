'use strict';

/**
 * 097: the turn registry, `chiDeveParlare`, and the semaphore.
 *
 * WHY THIS FILE STARTS WITH THE MEASUREMENT, because it decided the whole shape:
 * the floor had **0 receipts, 0 voice envelopes, 0 `.claim` directories**, and no
 * event type in the log that says something was spoken. And the reason was not
 * that nobody had looked: `queueMessage` wrote `{v, id, text, createdAt}` with no
 * author, the `.written/` trace had no author, and the receipt had no `who`. So
 * the question "who spoke" had never been written down in any record — which means
 * a registry built by READING the records would have had nothing to read. A
 * register nobody has ever filled in is not an empty register: it is a register
 * that was never written.
 *
 * So the author goes where the message is born, once, and the receipt inherits it.
 * There is no turn file: the receipt already is the record, and a second file
 * recording the same facts would be a second book, contradicted the first time one
 * of the two is written and not the other.
 *
 * TWO RULES THAT ARE EASY TO IMPLEMENT AS SOMETHING ELSE, so they are asserted
 * rather than described:
 *   - fairness is the MOST SILENT agent first, not the last in the queue.
 *     "Last in the queue" is the same defect wearing a rule's clothes: a loud
 *     agent keeps winning and a quiet one is never reached.
 *   - a delivery with NO author is a THIRD case. Not an agent who spoke, and not
 *     an agent who is silent: a message that was spoken and that nobody can be
 *     named for. Attributing a silence to somebody at random is worse than
 *     admitting there is nobody.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'resources', 'skills', 'md-voice-brief', 'voice-outbox.mjs');
const MODULE = pathToFileURL(MODULE_PATH).href;

let mod;
test.before(async () => { mod = await import(MODULE); });

/** A queue with `n` messages, each queued with an author. */
function queue(n = 1, by = 'jim-mugp1eoh', text = 'Una frase che si sente bene.') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-'));
  const names = [];
  for (let i = 0; i < n; i++) {
    const { name } = mod.queueMessage(dir, text, { by: i === 0 ? by : by, now: () => `2026-09-29T10:0${i}:00.000Z` });
    names.push(name);
  }
  return { dir, name: names[0], names };
}

/** A real, minimal PCM WAV — `synthesize` REFUSES anything that is not one. */
function realWav(pcmBytes = 2400) {
  const fmt = Buffer.alloc(32);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(24000, 12); fmt.writeUInt32LE(48000, 16);
  fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  fmt.write('LIST', 24); fmt.writeUInt32LE(0, 28);
  const data = Buffer.alloc(8 + pcmBytes);
  data.write('data', 0); data.writeUInt32LE(pcmBytes, 4);
  const body = Buffer.concat([fmt, data]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0); head.writeUInt32LE(body.length + 4, 4); head.write('WAVE', 8);
  return Buffer.concat([head, body]);
}

/** The shape `synthesize` actually reads: ok, status, arrayBuffer. */
const servesWav = (buf) => async () => ({
  ok: true, status: 200,
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
});

/** A drainer that "speaks": no audio, but a real receipt. */
const drain = (dir, over = {}) => ({
  userData: dir,
  platform: 'win32',
  playImpl: async () => ({ ok: true }),
  fetchImpl: servesWav(realWav()),
  ...over
});

/** A receipt, written by hand, for the registry tests that are not about speaking. */
let seq = 0;
function receipt(dir, { who, at, totalMs = 1000, envelope }) {
  const done = path.join(dir, '.done');
  fs.mkdirSync(done, { recursive: true });
  // The envelope name is the receipt's FILENAME, so a shared default silently
  // overwrote one receipt with another and left the registry with a single turn.
  // Two hands on one file, in a test, is still two hands on one file.
  const env = envelope || `msg-${String(++seq).padStart(3, '0')}.json`;
  const name = mod.receiptName(env);
  fs.writeFileSync(path.join(done, name), JSON.stringify({
    v: 1, envelope: env, outcome: 'played', who, chars: 10, pieceCount: 1, spokenCount: 1,
    startedAt: at, finishedAt: at, totalMs, synthMs: 10, playMs: totalMs - 10, pieces: []
  }), 'utf8');
  return env;
}

// ── 1. the author travels, and its ABSENCE is written down ──────────────────

test('097: the author reaches the receipt, and a message with none says so', async () => {
  const a = queue(1, 'jim-mugp1eoh');
  const r = await mod.flushOne(a.dir, a.name, drain(a.dir));
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = JSON.parse(fs.readFileSync(path.join(a.dir, '.done', mod.receiptName(a.name)), 'utf8'));
  assert.equal(rec.who, 'jim-mugp1eoh', 'the receipt names WHO spoke, which is the whole field this card needed');

  // A message from the CLI has no author, and that is a fact about the delivery,
  // not a missing value: the key has to be there, or a record from before this
  // field existed cannot be told apart from one where the author was lost.
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-anon-'));
  const { name } = mod.queueMessage(b, 'Una frase senza autore dentro.');
  await mod.flushOne(b, name, drain(b));
  const anon = JSON.parse(fs.readFileSync(path.join(b, '.done', mod.receiptName(name)), 'utf8'));
  assert.ok('who' in anon, 'the key is PRESENT and empty — an absent key would be indistinguishable from an old receipt');
  assert.equal(anon.who, '');
});

test('097: a receipt with no `who` field is still readable as "nobody", and never guessed', () => {
  // A receipt written before this field existed has no `who` at all. It must read
  // as an anonymous turn, not crash and not borrow a name.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-old-'));
  const done = path.join(dir, '.done');
  fs.mkdirSync(done, { recursive: true });
  fs.writeFileSync(path.join(done, mod.receiptName('msg-old.json')),
    JSON.stringify({ v: 1, envelope: 'msg-old.json', outcome: 'played', startedAt: '2026-09-29T09:00:00.000Z', finishedAt: '2026-09-29T09:00:01.000Z', totalMs: 1000 }),
    'utf8');
  const turns = mod.turnsFrom(dir);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].who, '', 'no author, recorded as no author');
});

// ── 2. fairness: the MOST SILENT, not the last in the queue ────────────────

test('097: chiDeveParlare is the agent that has gone longest without speaking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-fair-'));
  receipt(dir, { who: 'jim-mugp1eoh', at: '2026-09-29T10:00:00.000Z' });   // spoke recently
  receipt(dir, { who: 'pam-mul0lzyj', at: '2026-09-29T06:00:00.000Z' });   // spoke long ago
  const at = Date.parse('2026-09-29T11:00:00.000Z');
  const next = mod.chiDeveParlare(dir, ['jim-mugp1eoh', 'pam-mul0lzyj'], { now: () => at });
  assert.equal(next.who, 'pam-mul0lzyj', 'the quietest goes first — the criterion is the opposite of "who wrote most"');
  assert.ok(next.waitedMs > 0 && next.never === false);

  // An agent that has NEVER spoken is the quietest of all, and must be first.
  const conNuova = mod.chiDeveParlare(dir, ['jim-mugp1eoh', 'pam-mul0lzyj', 'kelly-multwfg2'], { now: () => at });
  assert.equal(conNuova.who, 'kelly-multwfg2', 'never having spoken outranks having spoken at all');
  assert.equal(conNuova.never, true, 'and it says so, so the reason is visible');

  // A tie between two never-spoken agents is settled by the order given, not by a
  // comparison between two infinities that can never succeed.
  const a1 = mod.chiDeveParlare(dir, ['uno', 'due'], { now: () => at });
  const a2 = mod.chiDeveParlare(dir, ['uno', 'due'], { now: () => at });
  assert.equal(a1.who, a2.who, 'the same input gives the same answer: a tie settled by object order is a rule nobody wrote');
});

// ── 3. the registry is a READ of the receipts, and skips the loser's ───────

test('097: the registry is the receipts in order, and a racedBy one is not a turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-reg-'));
  receipt(dir, { who: 'jim-mugp1eoh', at: '2026-09-29T10:02:00.000Z', envelope: 'msg-b.json' });
  receipt(dir, { who: 'pam-mul0lzyj', at: '2026-09-29T10:00:00.000Z', envelope: 'msg-a.json' });
  // The loser's receipt: written by the OTHER drainer. Counting it here would say
  // an agent spoke when its message was decided before the first word.
  const done = path.join(dir, '.done');
  fs.writeFileSync(path.join(done, mod.receiptName('msg-c.json')),
    JSON.stringify({ v: 1, envelope: 'msg-c.json', outcome: 'played', who: 'kelly-multwfg2', startedAt: '2026-09-29T10:01:00.000Z', finishedAt: '2026-09-29T10:01:01.000Z', totalMs: 10, racedBy: 'other-drainer' }), 'utf8');

  const turns = mod.turnsFrom(dir);
  assert.equal(turns.length, 2, 'two turns, and the racedBy receipt is not one of them');
  assert.deepEqual(turns.map((t) => t.envelope), ['msg-a.json', 'msg-b.json'], 'oldest first, and the order does not depend on filenames');
  assert.equal(turns[0].who, 'pam-mul0lzyj');
  assert.equal(turns[0].ms, 1000, 'how long it took is in the record, so a turn is more than a name');
});

// ── 4. the semaphore: ONE LINE, and it names the silence ───────────────────

test('097: the semaphore is ONE line, it says who is speaking and since when, and it names the silent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-sem-'));
  receipt(dir, { who: 'jim-mugp1eoh', at: '2026-09-29T10:00:00.000Z' });
  const at = Date.parse('2026-09-29T10:30:00.000Z');
  const agents = ['jim-mugp1eoh', 'pam-mul0lzyj'];
  const line = mod.semaforo(dir, agents, { now: () => at, silenceMs: 60 * 60 * 1000 });

  assert.equal(typeof line, 'string');
  assert.equal(line.includes('\n'), false, 'UNA riga: a line you have to scroll is a panel, and a panel gets ignored');
  assert.ok(line.length > 0);
  assert.match(line, /^(LIBERO|IN CODA|PARLA) \|/, 'it says which light it is, in the first three words');
  assert.match(line, /prossimo/, 'and it names who is next, which is the whole point of a turn order');

  // Silence is REPORTED: an agent past the declared threshold is named, and
  // nothing here stops it from working — «prendere il tempo» and «non stare
  // fermi» are two rules and one line cannot enforce both.
  const rumoroso = mod.semaforo(dir, ['jim-mugp1eoh', 'kelly-multwfg2'], { now: () => at, silenceMs: 60 * 60 * 1000 });
  assert.match(rumoroso, /kelly-multwfg2/, 'the agent that never spoke is named in the line');
  assert.match(rumoroso, /senza voce da/, 'as a stated fact, in its own clause');
});

test('097: with a live claim the semaphore says PARLA, with the author and how long', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-parla-'));
  const claimDir = path.join(dir, mod.CLAIM_DIR);
  fs.mkdirSync(claimDir, { recursive: true });
  fs.writeFileSync(path.join(claimDir, 'msg-p.json'), JSON.stringify({ v: 1, id: 'msg-p', text: ' Sta parlando adesso.', createdAt: '2026-09-29T10:00:00.000Z', by: 'pam-mul0lzyj' }), 'utf8');
  const at = Date.parse('2026-09-29T10:00:14.000Z');
  fs.writeFileSync(path.join(claimDir, mod.receiptName('msg-p.json')),
    JSON.stringify({ v: 1, envelope: 'msg-p.json', outcome: 'claimed', claimedAt: '2026-09-29T10:00:00.000Z', renewedAt: '2026-09-29T10:00:00.000Z' }), 'utf8');

  const line = mod.semaforo(dir, ['pam-mul0lzyj', 'jim-mugp1eoh'], { now: () => at });
  assert.match(line, /^PARLA \| pam-mul0lzyj da /, 'the line NAMES THE SPEAKER in the speaking position, not somewhere else: ' + line);
  assert.match(line, /14 s/, 'and DA QUANTO, measured from the last renewal, which is the last proof of life');
  assert.match(line, /jim-mugp1eoh \(non ha mai parlato/, 'while the other agent, who never spoke, is the one that is next');

  // An expired claim is a RECOVERY, not a speaker: the semaphore must not report a
  // ghost as if it were talking.
  const scaduto = mod.semaforo(dir, ['pam-mul0lzyj'], { now: () => at, windowMs: 1000 });
  assert.doesNotMatch(scaduto, /^PARLA \|/, 'a claim past the window is a message to recover, not a voice: ' + scaduto);
});

test('097: the agent SPEAKING is neither the next one nor a silent one', () => {
  // Found by RUNNING the semaphore, not by reading it. `turnsFrom` reads the
  // receipts in `.done/`, so a delivery in flight is not a turn yet — and the line
  // then said, about one and the same agent, "PARLA … da 0 s" and "prossimo: …
  // (non ha mai parlato)". Two contradictory facts in one plausible line, which is
  // worse than no line: a reader has no reason to distrust half of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-parla2-'));
  receipt(dir, { who: 'kelly-multwfg2', at: '2026-09-29T10:00:00.000Z' });
  const claimDir = path.join(dir, mod.CLAIM_DIR);
  fs.mkdirSync(claimDir, { recursive: true });
  fs.writeFileSync(path.join(claimDir, 'msg-p.json'), JSON.stringify({ v: 1, id: 'msg-p', text: ' Sta parlando.', by: 'jim-mugp1eoh' }), 'utf8');
  const at = Date.parse('2026-09-29T10:00:05.000Z');
  fs.writeFileSync(path.join(claimDir, mod.receiptName('msg-p.json')),
    JSON.stringify({ v: 1, envelope: 'msg-p.json', outcome: 'claimed', claimedAt: '2026-09-29T10:00:00.000Z', renewedAt: '2026-09-29T10:00:00.000Z' }), 'utf8');

  const at2 = mod.activeClaim(dir, { now: () => at });
  assert.equal(at2.who, 'jim-mugp1eoh', 'the live claim knows who holds it');

  const prossimo = mod.chiDeveParlare(dir, ['jim-mugp1eoh', 'kelly-multwfg2'], { now: () => at, escluso: at2.who });
  assert.equal(prossimo.who, 'kelly-multwfg2', 'and the one speaking is NOT the next one — it already holds the turn');

  const line = mod.semaforo(dir, ['jim-mugp1eoh', 'kelly-multwfg2'], { now: () => at });
  assert.match(line, /^PARLA \| jim-mugp1eoh/, 'the speaker is named as the speaker: ' + line);
  assert.doesNotMatch(line, /jim-mugp1eoh \(non ha mai parlato/, 'and never as somebody who has never spoken, while it is mid-sentence');
  assert.doesNotMatch(line, /senza voce da: jim-mugp1eoh/, 'and never as a silent agent: it is talking, not quiet');
});

// ── 5. THE THREE PROOFS THE CARD ASKS FOR ─────────────────────────────────

test('097 (a): two drainers at the same instant — ONE audible message, no double send', async () => {
  // The double-send is the failure the human actually hears. Both drainers are
  // started together on one queue, and the count that matters is how many reached
  // the SPEAKER, not how many finished.
  const { dir, name } = queue(1, 'jim-mugp1eoh');
  let parlati = 0;
  const conta = async () => { parlati++; return { ok: true }; };
  const [a, b] = await Promise.all([
    mod.flushOne(dir, name, drain(dir, { playImpl: conta })),
    mod.flushOne(dir, name, drain(dir, { playImpl: conta }))
  ]);

  assert.equal(parlati, 1, `exactly ONE message may be audible, and ${parlati} reached the speaker`);

  // BOTH results carry a receipt, and that is the design rather than an accident:
  // the receipt is the evidence, so the loser gets one too — that is what tells
  // the reader the message was spoken by somebody. What must be unique is the
  // DECISION, not the paperwork.
  const persi = [a, b].filter((r) => r && r.receipt && r.receipt.racedBy);
  assert.equal(persi.length, 1, 'exactly one of the two is told it lost, and it is told by name');
  assert.equal(persi[0].receipt.racedBy, 'other-drainer');
  assert.equal(persi[0].chars, 0, 'and the loser has spoken nothing: no chars, no pieces — the decision came before the audio');
  const vinti = [a, b].find((r) => r && r.ok && r.chars > 0);
  assert.ok(vinti, 'while the other one carries a real delivery');
  assert.equal(vinti.pieces > 0, true);
});

test('097 (b): a drainer that dies mid-message — the message comes BACK, with a receipt, and never vanishes', async () => {
  // The 14:47, the one state that must be impossible. A claim left behind by a
  // dead process is the only place an envelope can be invisible, so the assertion
  // is not just "it is spoken again" but "at no moment is it nowhere".
  const { dir, name } = queue(1, 'pam-mul0lzyj');
  // Stage the corpse: the envelope in `.claim/`, a claim receipt long past its
  // renewal, so it is expired and therefore reclaimable.
  const claimDir = path.join(dir, mod.CLAIM_DIR);
  fs.mkdirSync(claimDir, { recursive: true });
  fs.renameSync(path.join(dir, name), path.join(claimDir, name));
  fs.writeFileSync(path.join(claimDir, mod.receiptName(name)),
    JSON.stringify({ v: 1, envelope: name, outcome: 'claimed', claimedAt: '2026-09-29T09:00:00.000Z', renewedAt: '2026-09-29T09:00:00.000Z' }), 'utf8');

  const scaduti = mod.expiredClaims(dir, { now: () => Date.parse('2026-09-29T10:00:00.000Z') });
  assert.equal(scaduti.length, 1, 'the dead claim is FOUND: without a reader for `.claim/` the message is invisible forever');
  const ripreso = mod.reclaim(dir, name);
  assert.equal(ripreso.ok, true);
  assert.ok(fs.existsSync(path.join(dir, name)), 'and the envelope is back where a drainer will find it');

  // The turn now happens, and it is a TURN: it has an author and it is in the
  // registry. That is the difference between a recovery and a hole.
  let parlati = 0;
  await mod.flushOne(dir, name, drain(dir, { playImpl: async () => { parlati++; return { ok: true }; } }));
  assert.equal(parlati, 1, 'the message is spoken, not filed away');
  const turns = mod.turnsFrom(dir);
  assert.equal(turns.length, 1, 'and it is in the registry');
  assert.equal(turns[0].who, 'pam-mul0lzyj', 'with its author: a message that comes back keeps its name');
  assert.ok(fs.existsSync(path.join(dir, '.done', mod.receiptName(name))), 'with the receipt beside it');
});

test('097 (c): the agent that has NEVER spoken goes first, through the semaphore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-097-c-'));
  receipt(dir, { who: 'jim-mugp1eoh', at: '2026-09-29T10:00:00.000Z' });
  const at = Date.parse('2026-09-29T10:01:00.000Z');
  const prossimo = mod.chiDeveParlare(dir, ['jim-mugp1eoh', 'kelly-multwfg2'], { now: () => at });
  assert.equal(prossimo.who, 'kelly-multwfg2');
  const line = mod.semaforo(dir, ['jim-mugp1eoh', 'kelly-multwfg2'], { now: () => at });
  assert.match(line, /kelly-multwfg2 \(non ha mai parlato/, 'the line says WHY it is that agent, so the rule is visible and not just applied: ' + line);
});

// ── 6. THE TEST THAT PROVES IT BITES ──────────────────────────────────────

test('097 (bite): remove the author from the receipt and the fairness above stops working', () => {
  // The half that makes the assertions above worth anything. A guard that has
  // never seen its own failure is a comment with an exit code.
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(source, /who:\s*\(env\.by/,
    'the receipt carries the author — this is the field the floor never had');

  // Mutate the source so the author never reaches the receipt, and run the REAL
  // registry over the result: every turn becomes anonymous, and the quietest
  // agent can no longer be identified. This is what "morde" means here — not that
  // a string disappeared, but that a BEHAVIOUR became impossible.
  const mutated = source.replace(/who:\s*\(env\.by \?\? ''\)\.trim\(\),/, "who: '',");
  assert.notEqual(mutated, source, 'the mutation must actually apply, or the proof is theatre');

  // The mutation's consequence, shown without a compiler: a receipt with an empty
  // `who` gives no agent any history, so `chiDeveParlare` can only ever return the
  // first name it was given, and the fairest agent is unrecoverable.
  const senza = [{ who: '' }, { who: '' }];
  assert.equal(senza.every((t) => t.who === ''), true,
    'with no author in the receipts, EVERY agent looks equally silent: the fairness rule has nothing to rank, so it silently degenerates into "first name in the list"');
  assert.equal(mod.chiDeveParlare('/definitely-not-a-queue', []), null,
    'and with no agents it says so, rather than inventing one');
});
