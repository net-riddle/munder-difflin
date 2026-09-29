'use strict';

/**
 * 099: a missing `in_reply_to` is not a wrong addressee.
 *
 * `to` is WHERE a message lands. `in_reply_to` is WHERE IT CAME FROM. A bad
 * address is a delivery fault and stops the message; a missing parent is a
 * metadata fault and must not — the recipient is valid and the text is
 * somebody's. So the rule here is a rule about what does NOT happen: the message
 * is delivered, every time, and the sender is told once about the thread.
 *
 * THE MEASUREMENT THAT SET THE THRESHOLD (2026-09-29, the floor's own files,
 * backups excluded because a backup answers "did it exist", not "does it"):
 *
 *   1 822 messages read, 1 103 distinct ids
 *   646 messages carry an `in_reply_to`      → the field is genuinely used
 *     21 of them point at nothing            → 3,3 % of references
 *   612 real conversations, 7 with a dead thread → 1,1 %
 *   9 of the 10 distinct dead ids are cited MORE THAN ONCE, one of them 4 times
 *
 * That last line is the whole reason the warning is deduplicated: without it,
 * one missing broadcast would have produced four lines about a single fact.
 * 20 messages would have produced 20 warnings for 9 threads. *A warning per
 * message is a complaint; a warning per thread is a report.*
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, BROKEN_THREAD_MARKER } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-filo-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-mul0lzyj', name: 'Pam', provider: 'claude', cwd: home });
  return { home, hive };
}

const avvisi = (hive, chi) => hive.inbox(chi).filter((m) => String(m.subject || '').startsWith(BROKEN_THREAD_MARKER));

// ── 1. it is delivered, and that is the whole point ────────────────────────

test('099: a dead in_reply_to does NOT stop the delivery — the recipient still gets the text', async (t) => {
  const { hive } = await floor(t);
  hive.send({
    to: 'pam-mul0lzyj', act: 'inform', subject: 'la risposta', body: 'il testo',
    in_reply_to: '2026-01-01T00-00-00-000Z-messaggio-che-non-esiste'
  }, 'jim-1');

  assert.equal(hive.inbox('pam-mul0lzyj').length, 1,
    'THE LIMIT THAT IS NOT NEGOTIABLE. `to` is valid, the text is somebody\'s, and a field that does not change who receives the message cannot be grounds for killing it. Rejecting here is the same shape of error as the breaker lock I moved off the speaking path in 093: a guard in the wrong place, punishing someone else\'s mistake.');
  assert.equal(hive.inbox('pam-mul0lzyj')[0].body, 'il testo', 'and the text arrives whole, which is the point of delivering it at all');
});

test('099: the sender is told, and the marker never says the delivery failed', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'pam-mul0lzyj', act: 'inform', subject: 'la risposta', body: 'x',
    in_reply_to: 'inesistente-1' }, 'jim-1');

  const a = avvisi(hive, 'jim-1');
  assert.equal(a.length, 1, 'the sender hears about the break, once: ' + JSON.stringify(hive.inbox('jim-1').map((m) => m.subject)));
  assert.match(a[0].subject, /WAS delivered/,
    'THE TWO MARKERS SAY OPPOSITE THINGS about one delivery, and reusing one for the other is a marker that has stopped carrying meaning. `[broken thread]`, never `[undeliverable]`.');
  assert.equal(a[0].subject.includes('undeliverable'), false);
  assert.match(a[0].subject, /inesistente-1/, 'it names the missing parent, so the sender can see WHICH thread broke');
  assert.match(a[0].subject, /"la risposta"/, 'and it quotes the subject, labelled, for the same reason the refusal does: a sender with a dozen subjects open needs to know which one');
});

// ── 2. THE TEST THAT MUST GO RED IF THE DEDUP GOES AWAY ────────────────────

test('099: the same dead thread warns ONCE, not once per message', async (t) => {
  const { home, hive } = await floor(t);
  const outbox = path.join(home, 'hive', 'agents', 'jim-1', 'outbox');
  const morto = '2026-09-28T18-41-20-371Z-god-closing-broadcast.json';

  // Two messages, same sender, same missing parent — the shape the floor's own
  // files show four times over for one dead broadcast.
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(outbox, `filo-${n}.json`), JSON.stringify({
      to: 'pam-mul0lzyj', act: 'inform', subject: `filo ${n}`, body: 'x', in_reply_to: morto
    }), 'utf8');
  }
  assert.ok(hive.routeOnce() >= 2, 'the router really picked both up, so this is not passing vacuously');

  assert.equal(hive.inbox('pam-mul0lzyj').length, 2, 'BOTH were delivered: the second one is not a victim of the first one\'s broken parent');

  const detti = avvisi(hive, 'jim-1');
  assert.equal(detti.length, 1,
    'ONE warning for one broken thread. This is the assertion that dies if the dedup is removed: the second message about the same missing parent carries nothing the first did not, and it costs the sender an inbox line. *The thread broke once.*');

  // and the fact is still recorded twice in the log — the dedup is about the
  // INBOX LINE, not about the audit trail. Silently forgetting the second
  // occurrence would be a ledger that edits itself.
  const voci = hive.logTail(500).filter((e) => e.kind === 'broken-thread' && e.ref === morto.replace(/\.json$/, ''));
  assert.equal(voci.length, 2, 'both occurrences are in the log, one of them marked told=false');
  assert.deepEqual(voci.map((v) => v.told), [true, false],
    'and the log says WHICH one was told. An audit trail that cannot distinguish "we told them" from "we decided not to" is a list, not a record.');
});

// ── 3. silence where there is nothing to say ───────────────────────────────

test('099: a VALID in_reply_to says nothing at all, and stays silent as before', async (t) => {
  const { home, hive } = await floor(t);
  const outbox = path.join(home, 'hive', 'agents', 'jim-1', 'outbox');

  const padre = path.join(home, 'hive', 'agents', 'pam-mul0lzyj', 'inbox');
  fs.mkdirSync(padre, { recursive: true });
  const idPadre = '2026-09-29T10-00-00-000Z-padre';
  fs.writeFileSync(path.join(padre, `${idPadre}.json`),
    JSON.stringify({ id: idPadre, from: 'pam-mul0lzyj', to: 'jim-1', act: 'inform', subject: 'il padre', body: 'x' }), 'utf8');

  fs.writeFileSync(path.join(outbox, 'figlio.json'), JSON.stringify({
    to: 'pam-mul0lzyj', act: 'inform', subject: 'il figlio', body: 'x', in_reply_to: idPadre
  }), 'utf8');
  hive.routeOnce();

  assert.equal(hive.inbox('pam-mul0lzyj').length, 2, 'the reply is delivered');
  assert.equal(avvisi(hive, 'jim-1').length, 0,
    'AND NOTHING IS SAID. A warning that appears when there is nothing wrong is noise, and noise is how a guard gets removed: the second broken thread gets no warning because the first one taught the reader that this line means nothing.');
  assert.equal(hive.logTail(500).filter((e) => e.kind === 'broken-thread').length, 0,
    'and the log stays clean too — not even a silent entry, because a log entry nobody reads is still a claim that something happened');
});

test('099: the .json suffix on a reference does not make a real parent look dead', async (t) => {
  // Measured on the floor: references come in both forms —
  // `2026-09-28T18-41-20-371Z-god-closing-broadcast.json` and
  // `2026-09-25T08-27-06-489Z-2082b0`. Comparing the raw strings would call half
  // of all real references broken, and every one of those would be a false alarm.
  const { home, hive } = await floor(t);
  const padre = path.join(home, 'hive', 'agents', 'pam-mul0lzyj', 'inbox');
  fs.mkdirSync(padre, { recursive: true });
  const idPadre = '2026-09-29T11-00-00-000Z-con-suffisso';
  fs.writeFileSync(path.join(padre, `${idPadre}.json`),
    JSON.stringify({ id: idPadre, from: 'pam-mul0lzyj', to: 'jim-1', act: 'inform', subject: 'p', body: 'x' }), 'utf8');

  const outbox = path.join(home, 'hive', 'agents', 'jim-1', 'outbox');
  fs.writeFileSync(path.join(outbox, 'figlio.json'), JSON.stringify({
    to: 'pam-mul0lzyj', act: 'inform', subject: 'f', body: 'x', in_reply_to: idPadre + '.json'
  }), 'utf8');
  hive.routeOnce();

  assert.equal(avvisi(hive, 'jim-1').length, 0,
    'the parent is right there under its own name; adding ".json" to a reference is a spelling, not a different message');
});
