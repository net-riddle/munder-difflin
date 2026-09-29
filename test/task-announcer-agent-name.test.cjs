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
const loadTs = require('./load-ts.cjs');

const ann = loadTs('src/main/taskDoneAnnouncer.ts');

const REAL_REGISTRY =
  'F:/workspace/projects/ai-office/nemesi-office/hive/registry.json';
const hasReal = fs.existsSync(REAL_REGISTRY);
const real = hasReal ? JSON.parse(fs.readFileSync(REAL_REGISTRY, 'utf8')) : null;

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

test('the id fallback still exists, and it is the thing the human objected to', () => {
  // Pinned from BOTH sides on purpose. The fallback is documented behaviour
  // ("else the raw id"), so a test that only wanted names would pass while the
  // user kept hearing ids whenever a lookup fails. This says: yes, the fallback
  // is still there — which is why the lookup above is tested against the real
  // file rather than trusted.
  const card = { id: 'x', assignee: 'jim-mugp1eoh', status: 'done' };
  assert.equal(ann.whoOf(card, () => null), 'jim-mugp1eoh',
    'documented: with no name available the raw id is spoken');
  assert.equal(ann.whoOf(card, undefined), 'jim-mugp1eoh');
  assert.equal(ann.whoOf({ id: 'x', status: 'done' }, () => 'Jim'), '',
    'and a card with nobody assigned is announced without a who, not with a blank id');
});
