'use strict';
/**
 * Capabilities: the machine-readable answer to "who SHOULD be doing this".
 *
 * The test that earns this field its place is the one in
 * `a designation that outlives its subject answers nobody` — it is a
 * regression against a real night, not against a hypothetical.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const cap = loadTs('src/main/capabilities.ts');

// The two KELLYS, verbatim from the 2026-09-28 floor: same name, same job, two
// spellings, one archived 15 seconds after spawning. This is the shape that made
// "who sends the voice messages" have two correct answers.
const KELLY_TONIGHT = [
  { id: 'kelly-multst41', capabilities: [], archived: true },
  { id: 'kelly-multwfg2', capabilities: ['voice-sender'], archived: false }
];
const onDisk = (...ids) => (id) => ids.includes(id);

test('the vocabulary is closed, and it is five values', () => {
  assert.deepEqual([...cap.CAPABILITIES],
    ['orchestrator', 'office-dev', 'cacioverse', 'rush-breaker', 'voice-sender']);
  // A vocabulary that grows on demand is not a vocabulary: the whole reason this
  // field is queryable is that there is a fixed set to query against.
  assert.equal(cap.CAPABILITIES.length, 5);
});

test('a value outside the vocabulary is dropped, never repaired into one', () => {
  // "VocalSender" is the spelling that existed on this floor last night. Guessing
  // that it means "voice-sender" would be a guess, and a wrong guess is
  // indistinguishable from a right one until the day it is load-bearing.
  const r = cap.normalizeCapabilities(['VocalSender', 'voice-sender', ' Developer ', 'triage']);
  assert.deepEqual(r.kept, ['voice-sender']);
  assert.deepEqual(r.rejected, ['VocalSender', 'Developer', 'triage']);
  assert.equal(cap.isCapability('VocalSender'), false);
  assert.equal(cap.isCapability('voice-sender'), true);
});

test('the two spellings of one job are ONE designation, decided by the system', () => {
  // "Developer" and "developer" were both live on this floor, which is why "all
  // the developers" could not be asked at all. Capabilities are derived from
  // facts the system owns, so a person cannot split one job into two.
  const jim = cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\rush-breaker' });
  const pam = cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\cacioverse' });
  assert.deepEqual(jim, ['rush-breaker']);
  assert.deepEqual(pam, ['cacioverse']);
  // Same folder, spelled two ways -> same designation. The case bug that made
  // role unqueryable cannot happen here.
  assert.deepEqual(jim, cap.deriveCapabilities({ cwd: 'f:/workspace/projects/RUSH-BREAKER' }));
});

test('the system assigns from isGod and cwd, and never from prose', () => {
  assert.deepEqual(cap.deriveCapabilities({ isGod: true }), ['orchestrator']);
  assert.deepEqual(
    cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\munder-difflin' }),
    ['voice-sender']);
  // office-dev is NOT derived: no existing fact says who is an office developer,
  // and inventing one would be inventing a designation.
  const d = cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\cacioverse' });
  assert.ok(!d.includes('office-dev'), 'nothing in cwd or isGod says "office developer"');
  // And a role in any language cannot leak in, because the signature has no slot
  // for it.
  assert.equal(cap.deriveCapabilities.length, 1);
});

test('"who should send the voice messages" answers ONE id, and it is the live one', () => {
  const r = cap.whoShouldDo(KELLY_TONIGHT, 'voice-sender', { agentFolderExists: onDisk('kelly-multwfg2') });
  assert.deepEqual(r.agents, ['kelly-multwfg2']);
  assert.equal(r.ambiguous, false);
});

test('a designation that outlives its subject answers NOBODY, not a second candidate', () => {
  // THE REGRESSION. If the folder is gone, the agent does not exist as a worker,
  // and the answer is zero — NOT some other holder of the same capability. A
  // designation that survives its subject is a memory, not a designation.
  const folderGone = cap.whoShouldDo(KELLY_TONIGHT, 'voice-sender', { agentFolderExists: onDisk() });
  assert.deepEqual(folderGone.agents, [], 'a dead folder must answer nobody, never a fallback');
  // And the reason is visible, so "nobody" is never a silent shrug.
  assert.deepEqual(folderGone.deadDesignations, ['kelly-multwfg2']);

  // The archived twin is the same shape: it is excluded AND reported.
  const archivedOnly = cap.whoShouldDo(
    [{ id: 'kelly-multst41', capabilities: ['voice-sender'], archived: true }],
    'voice-sender', { agentFolderExists: onDisk('kelly-multst41') });
  assert.deepEqual(archivedOnly.agents, []);
  assert.deepEqual(archivedOnly.deadDesignations, ['kelly-multst41']);
});

test('a dead designation never promotes a bystander', () => {
  // The failure mode that would be easiest to write by accident: "nobody holds
  // it, so return whoever is on the floor". That is the mistake the whole field
  // exists to prevent, so it is pinned from the other side.
  const bystander = [
    { id: 'kelly-multst41', capabilities: ['voice-sender'], archived: true },
    { id: 'jim-mugp1eoh', capabilities: ['rush-breaker'], archived: false }
  ];
  const r = cap.whoShouldDo(bystander, 'voice-sender', { agentFolderExists: onDisk('jim-mugp1eoh', 'kelly-multst41') });
  assert.deepEqual(r.agents, [], 'a bystander with a different capability is not a substitute');
  assert.deepEqual(r.deadDesignations, ['kelly-multst41']);
});

test('two live holders is an ambiguity to report, never a silent pick', () => {
  // If the designation is ever wrong twice, the answer must make that visible
  // instead of picking one and looking confident.
  const r = cap.whoShouldDo(
    [{ id: 'a-1', capabilities: ['voice-sender'] }, { id: 'b-2', capabilities: ['voice-sender'] }],
    'voice-sender', { agentFolderExists: onDisk('a-1', 'b-2') });
  assert.equal(r.agents.length, 2);
  assert.equal(r.ambiguous, true);
});

test('an unknown capability is answered as unknown, not as nobody-is-free', () => {
  // These three must not look alike to a caller, because they are three
  // different situations: no such capability, nobody designated it, two did.
  const r = cap.whoShouldDo(KELLY_TONIGHT, 'vocal messages', { agentFolderExists: onDisk('kelly-multwfg2') });
  assert.equal(r.unknownCapability, true);
  assert.deepEqual(r.agents, []);
  assert.equal(cap.whoShouldDo(KELLY_TONIGHT, 'cacioverse', { agentFolderExists: onDisk('kelly-multwfg2') }).unknownCapability, false);
});

test('it answers from the real registry shape, which is a map keyed by id', () => {
  // registry.json is `{ agents: { <id>: {...} } }`, NOT an array — reading it as
  // one is the mistake that produced a silent empty answer once already.
  const REGISTRY = {
    god: { id: 'god', capabilities: ['orchestrator'], archived: false },
    'jim-mugp1eoh': { id: 'jim-mugp1eoh', capabilities: ['rush-breaker'], archived: false }
  };
  const r = cap.whoShouldDo(REGISTRY, 'orchestrator', { agentFolderExists: onDisk('god') });
  assert.deepEqual(r.agents, ['god']);
});
