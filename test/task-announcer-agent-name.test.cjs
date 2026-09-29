'use strict';
/**
 * The name a voice says, and the one thing it must never say: a registry id.
 *
 * WHY THIS FILE EXISTS — a regression against a hearing, not a hypothetical.
 *
 * On 2026-09-29 the human reported: «A livello vocale viene ancora utilizzato
 * il nome completo dell'agente con il codice post il trattino, quello deve
 * essere rimosso». The cause was not stale code and not a missing restart.
 *
 * `index.ts` read the registry as `reg.agents.find(...)`. `registry.json` is
 * `{ godId, agents: { "jim-mugp1eoh": { id, name } } }` — a MAP. `find` is
 * `undefined` on a plain object, the TypeError was swallowed by a `catch` that
 * returned `null`, and `whoOf` then fell back to the raw id. So EVERY
 * announcement on the floor spoke the id, and the failure was silent: `null` is
 * a valid answer, and nothing logs it.
 *
 * The mistake was already documented in THIS repo for a different function —
 * `test/capabilities.test.cjs` says registry.json is "NOT an array — reading it
 * as one is the mistake that produced a silent empty answer once already". Made
 * once, written down, and made again three hours later in another file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');

const ann = loadTs('src/main/taskDoneAnnouncer.ts');

const REAL_REGISTRY =
  'F:/workspace/projects/ai-office/nemesi-office/hive/registry.json';
const hasReal = fs.existsSync(REAL_REGISTRY);
const real = hasReal ? JSON.parse(fs.readFileSync(REAL_REGISTRY, 'utf8')) : null;

// The second channel, and the only other place that decides a spoken name. The
// queue keeps its own map (`SUFFIXLESS_ID_NAMES` in voice-outbox.mjs) because
// `god` has no suffix and no shape can find it. Read through the module's own
// answer rather than by parsing the source, so the check cannot be satisfied by
// a string that happens to be in the file.
//
// MD_VOICE_QUEUE_MODULE points the check at a different copy of that file on
// purpose. Every agent also carries a per-agent copy of voice-outbox.mjs, and
// the process that actually speaks may be running one of those rather than this
// repo's — a check that can only look at the repo is a check that cannot see
// the copy in the mouth.
const QUEUE_MODULE = pathToFileURL(
  process.env.MD_VOICE_QUEUE_MODULE ||
    path.join(__dirname, '..', 'resources', 'skills', 'md-voice-brief', 'voice-outbox.mjs')
).href;
let queue;
test.before(async () => { queue = await import(QUEUE_MODULE); });

/** What the queue would have the speaker say for a suffixless id. */
function queueSays(token) {
  const found = (queue.findUnpronounceableNames(`${token} ha chiuso la card.`) || [])
    .find((f) => f.token === token);
  return found ? found.say : null;
}

/**
 * THE RELATION, as one assertion, used by the test and by its own proof.
 *
 * Two files hold the name the human hears when the orchestrator is announced:
 * `registry.json` -> `agents.<godId>.name`, read by the announcer, and
 * `voice-outbox.mjs` -> `SUFFIXLESS_ID_NAMES`, read by the queue. They are two
 * copies of one fact, in two channels, and nothing else keeps them together —
 * they agree today because both were written with the same word in them.
 *
 * The tests above assert the VALUE twice. Two equal assertions cannot notice
 * that they are two: change one and the other still passes. This one compares,
 * so moving either side is visible here and nowhere else.
 *
 * `registry.json` is READ, never written: it is the floor's roster, and a value
 * in two places is settled by removing one of them, not by adding a third.
 */
function assertOneSpokenName(reg) {
  const fromRegistry = ann.agentNameIn(reg, reg.godId);
  const fromQueue = queueSays(String(reg.godId));
  assert.ok(fromRegistry,
    `registry.json: agents.${reg.godId}.name is empty, so the announcer falls back to the raw id`);
  assert.ok(fromQueue,
    `voice-outbox.mjs: SUFFIXLESS_ID_NAMES has no entry for "${reg.godId}", so the queue has nothing to say`);
  assert.equal(fromQueue, fromRegistry,
    `"${reg.godId}" is announced as "${fromRegistry}" by registry.json and as ` +
    `"${fromQueue}" by voice-outbox.mjs. Two files hold the name the human ` +
    'hears; they are one fact and must be changed together — or, better, one of ' +
    'them removed.');
}

test('the registry on disk is a MAP keyed by id, so an array read cannot work', () => {
  // The shape assumption itself, asserted against the real file. This is the
  // assertion that was missing: the old code had a `catch` around a shape
  // assumption, and a catch converts "wrong" into "silently empty".
  if (!hasReal) return; // no floor to read; the other cases still hold
  assert.equal(Array.isArray(real.agents), false,
    'registry.json:agents is a map. If this ever becomes an array, the array ' +
    'branch of agentNameIn is the one that matters and this test must say so.');
  assert.equal(typeof real.agents.find, 'undefined');
  assert.equal(typeof real.agents['jim-mugp1eoh'], 'object');
});

test('every live agent id resolves to a name through the real registry', () => {
  if (!hasReal) return;
  for (const [id, entry] of Object.entries(real.agents)) {
    const name = ann.agentNameIn(real, id);
    assert.equal(name, entry.name,
      `${id} must resolve to "${entry.name}"; it resolved to ${JSON.stringify(name)}. ` +
      'A null here means every announcement falls back to the raw id — which is the bug.');
  }
});

test('the map shape resolves and the array shape also resolves', () => {
  // Both, because the old type claimed an array and the real file is a map: a
  // reader that handles only one of them is right on the day it is written and
  // wrong the day someone edits the file.
  const map = { godId: 'god', agents: { 'jim-mugp1eoh': { id: 'jim-mugp1eoh', name: 'Jim' } } };
  const arr = { agents: [{ id: 'jim-mugp1eoh', name: 'Jim' }] };
  assert.equal(ann.agentNameIn(map, 'jim-mugp1eoh'), 'Jim');
  assert.equal(ann.agentNameIn(arr, 'jim-mugp1eoh'), 'Jim');
});

test('an unknown id resolves to null, and never to a guess', () => {
  const map = { agents: { 'jim-mugp1eoh': { id: 'jim-mugp1eoh', name: 'Jim' } } };
  assert.equal(ann.agentNameIn(map, 'nobody-here9'), null);
  assert.equal(ann.agentNameIn(null, 'jim-mugp1eoh'), null);
  assert.equal(ann.agentNameIn({ agents: { a: { name: '   ' } } }, 'a'), null,
    'a blank name is not a name');
});

test('a card is announced by NAME, so no id reaches the speaker', () => {
  // The end-to-end shape of the defect, on the two functions the voice uses.
  const reg = { agents: { 'jim-mugp1eoh': { id: 'jim-mugp1eoh', name: 'Jim' } } };
  const who = ann.whoOf(
    { id: 'task-jim-085', assignee: 'jim-mugp1eoh', status: 'done' },
    (id) => ann.agentNameIn(reg, id)
  );
  assert.equal(who, 'Jim', 'the announcement says Jim');
  assert.ok(!/-[a-z0-9]{5,}$/i.test(who),
    `the announcement must not end in a registry id, and it said "${who}"`);
});

test('the id fallback is GONE: an unnameable agent is not announced as its id', () => {
  // Pinned from BOTH sides on purpose, because this is the third time this
  // function has been the mouth an id came out of. Before 2026-09-29 it was
  // `named ?? id` and the user heard the full agent name with the code after
  // the dash — the exact thing he asked to have removed. So the assertion is
  // now on the ABSENCE of the id, not on the presence of a name: a test that
  // only wanted names would pass while the user kept hearing ids.
  const card = { id: 'x', assignee: 'jim-mugp1eoh', status: 'done' };
  assert.equal(ann.whoOf(card, () => null), '',
    'a name that cannot be resolved yields no name, and the caller does not announce');
  assert.equal(ann.whoOf(card, undefined), '',
    'and with no lookup at all, still no id');
  assert.equal(ann.whoOf(card, () => '   '), '',
    'a blank name is not a name');
  assert.equal(ann.whoOf({ id: 'x', status: 'done' }, () => 'Jim'), '',
    'a card with nobody assigned is announced without a who, not with a blank id');
  // And the direction of the fix, so a future edit cannot quietly reintroduce
  // the id by another route.
  for (const lookup of [() => null, () => undefined, () => '', () => '  ']) {
    const who = ann.whoOf(card, lookup);
    assert.ok(!/-[a-z0-9]{5,}$/i.test(who),
      `nothing that looks like a registry id may be spoken, and it said "${who}"`);
  }
});

test('093: the name the human hears for god is ONE fact in two files', () => {
  // The real floor, against the real module. If either side moves, this is the
  // only assertion on the floor that notices.
  if (!hasReal) return; // no floor to read; the proof below still runs
  assertOneSpokenName(real);
});

test('093: the relation check can actually die, and it says where to look', () => {
  // A check that has never been seen red is a check nobody knows works. The
  // doctored registry differs from the module in exactly one word — the same
  // edit a rename would make — and the assertion has to fail while naming BOTH
  // files, because "they diverged" is only useful if it says which one moved.
  //
  // The divergence is DERIVED from whatever the queue says, not spelled out, so
  // this test cannot rot when the name changes: a hardcoded word here would
  // quietly stop being a divergence the day the real value became that word.
  const token = 'god';
  const live = queueSays(token);
  assert.ok(live, 'the queue must have a spoken name for the token under test');
  const diverged = { godId: token, agents: { [token]: { id: token, name: `${live} (renamed)` } } };
  assert.throws(
    () => assertOneSpokenName(diverged),
    (err) => /registry\.json/.test(err.message) && /voice-outbox\.mjs/.test(err.message),
    'a diverged pair must fail the relation, and the failure must name both files'
  );
});
