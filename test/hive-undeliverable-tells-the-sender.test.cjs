'use strict';

/**
 * 094: a refusal that reaches the COORDINATOR is a report, not a reply.
 *
 * `hive-unknown-recipient.test.cjs` already proves the bounce to god, the drop
 * log and the honest `delivered: []`. Those are right, and they were not enough —
 * which is what cost two messages on one floor (a `0l`/`l0` transposition to Pam,
 * and an invented id here), and nobody found out because **the coordinator heard
 * about it and the person who typed the wrong id did not.**
 *
 * TWO PROPERTIES THAT WERE MISSING, and both are the same sentence said twice:
 *
 *   2. THE REFUSAL IS IN THE SENDER'S SPACE. God learns; the sender learns nothing,
 *      because the only trace of a mis-addressed message lands in somebody else's
 *      inbox. `routeOnce` also archives the sender's file to `.sent/`, which is a
 *      folder the sender does not read — so from where they stand, a refusal and a
 *      delivery have the identical form: a file in `.sent/`.
 *   3. THE REFUSAL SAYS THE NEAR MISS. `pam-mul0zyj` and `pam-mul0lzyj` are two
 *      unrelated-looking strings, and a human told only "that id does not exist"
 *      still has to find the transposition themselves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, nearestAgentId, undeliverableReason, UNDELIVERABLE_MARKER } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tell-sender-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-mul0lzyj', name: 'Pam', provider: 'claude', cwd: home });
  return { home, hive };
}

// ── 1. the near-miss, and its threshold ────────────────────────────────────

test('094: the near-miss is found for a transposition and refused for a nonsense id', () => {
  const ids = ['god-1', 'jim-1', 'pam-mul0lzyj', 'kelly-multwfg2'];
  assert.equal(nearestAgentId('pam-mul0zyj', ids), 'pam-mul0lzyj',
    'the transposition — the case that actually cost a message — is named');
  assert.equal(nearestAgentId('grok', ids), null,
    'and an invented id gets NO hint, because a wrong hint is worse than none: it teaches people to ignore the line');
  assert.equal(nearestAgentId('', ids), null);
  assert.equal(nearestAgentId('jim-1', ids), null, 'an id that matches exactly is not a near-miss of itself');
});

test('094: the threshold is two edits and not one char more', () => {
  const ids = ['pam-mul0lzyj'];
  assert.equal(nearestAgentId('pam-mul0zyj', ids), 'pam-mul0lzyj',
    'a transposition is two edits and is named: this is the case that actually cost a message');
  assert.equal(nearestAgentId('pam-mul0lzi', ids), 'pam-mul0lzyj',
    'and ONE edit is named too — a single dropped character is the commonest typo there is, and a threshold that missed it would catch transpositions and miss the ordinary case');
  assert.equal(nearestAgentId('xyzmul0lzyj', ids), null,
    'THREE EDITS AND NOTHING IS SUGGESTED, and that is the half of the rule that matters: a wrong hint is worse than none, because it teaches the reader to skip the line. A suggestion that fires on ids which merely share a prefix is worse than no suggestion at all.');
  assert.ok(undeliverableReason('pam-mul0zyj', ids).includes('the closest is "pam-mul0lzyj"'));
  assert.ok(!undeliverableReason('grok', ids).includes('the closest is'),
    'and with nothing close the sentence says exactly that, and no more');
});

// ── 2. the sender is told, in the sender's own space ───────────────────────

test('094: a mis-addressed message is refused TO THE SENDER, naming the id they meant', async (t) => {
  const { hive } = await floor(t);

  // jim-1 → pam-mul0zyj. Two characters swapped, fourteen in all.
  hive.send({ to: 'pam-mul0zyj', act: 'request', subject: '091 — lo zero e\' la lettera', body: 'prova' }, 'jim-1');

  assert.equal(hive.inbox('pam-mul0lzyj').length, 0, 'the real Pam must NOT receive it: no wrong delivery');

  // ── PROPERTY 2: the refusal is in the SENDER's inbox, not only god's ──
  const miei = hive.inbox('jim-1');
  assert.equal(miei.length, 1,
    'THE SENDER IS TOLD. Before this the only trace went to god, so the person who typed the wrong id never heard about it, and the floor looked covered because the coordinator had heard.');
  assert.match(miei[0].subject, /^\[undeliverable — your message /,
    'and it is marked as a refusal, so a file in the sender\'s own inbox cannot read as a delivery: ' + miei[0].subject);
  assert.equal(miei[0].subject.includes('[['), false, 'one bracket, not two: a doubled bracket is a marker a reader learns to skip');

  // ── PROPERTY 3: it says the answer, not just that there was a problem ──
  assert.match(miei[0].subject, /pam-mul0lzyj/,
    'THE NEAR MISS IS NAMED. Fourteen characters with two swapped read as unrelated strings, and "that id does not exist" leaves the sender to find the typo themselves.');
  assert.match(miei[0].subject, /pam-mul0zyj/, 'and it repeats the id that was actually sent, so the two can be compared');
  assert.match(miei[0].subject, /NOT delivered/);
  assert.match(miei[0].subject, /your message "091 — lo zero e' la lettera"/,
    'the original subject is QUOTED AND LABELLED, not appended: a sender with a dozen subjects open needs to be told which one failed, and an appended tail is harder to match by eye than a quoted one');
  assert.equal(miei[0].body, 'prova', 'and so does the body');

  // the bounce to god still happens — the coordinator still needs to know
  assert.equal(hive.inbox('god-1').length, 1, 'and the coordinator is still told, because that is a different need');

  const drop = hive.logTail(500).find((e) => e.kind === 'drop' && e.reason === 'no-inbox');
  assert.equal(drop.to, 'pam-mul0zyj');
  assert.equal(drop.nearest, 'pam-mul0lzyj', 'the log carries the near-miss too, so a later reader can see it without re-running the diff');
  assert.equal(drop.toldSender, true, 'and it records that the sender was told, which is the fact this card exists to make visible');
});

test('094: god sending to a bad id is not told twice', async (t) => {
  // The sender IS the bounce target, so the sender-notified branch must not fire:
  // one refusal, not two files saying the same thing.
  const { hive } = await floor(t);
  hive.send({ to: 'nessuno-xyz', act: 'inform', subject: 'ciao' }, 'god-1');
  const inGod = hive.inbox('god-1');
  assert.equal(inGod.length, 1, 'one refusal, not two: ' + JSON.stringify(inGod.map((m) => m.subject)));
  assert.match(inGod[0].subject, /\[undeliverable/);
});

test('094: a refusal to the sender does not become a message the sender can bounce back', async (t) => {
  // The sender-notified copy carries an id and a subject. If it were routed as
  // ordinary mail back out of the sender's outbox it would loop, so it is delivered
  // directly and lands in the INBOX — which is exactly where a sender looks, and
  // is not re-read by `routeOnce`.
  const { hive } = await floor(t);
  hive.send({ to: 'nessuno-xyz', act: 'inform', subject: 'una' }, 'jim-1');
  const before = hive.inbox('jim-1').length;
  for (let i = 0; i < 5; i++) hive.routeOnce();
  assert.equal(hive.inbox('jim-1').length, before,
    'five more routing passes produce no further refusals: the refusal is a delivered fact, not something that keeps bouncing');
  assert.equal(hive.logTail(500).filter((e) => e.kind === 'drop' && e.reason === 'no-inbox').length, 1,
    'and the drop is counted once, not once per pass');
});
