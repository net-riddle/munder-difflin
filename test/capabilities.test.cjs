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

test('a birth directory does NOT designate a job, and the counterexample is on this floor', () => {
  // god, task-jim-091: the table matched `cwd` substrings, so the field that
  // answers "who should be doing this" was answering "who was started here".
  // jim-mugp1eoh is not a synthetic fixture: his cwd IS
  // F:/workspace/projects/rush-breaker and his write lane is munder-difflin +
  // hive, so the old table designated the one agent on the floor whose lane is
  // NOT rush-breaker as the rush-breaker agent.
  //
  // A directory is not a function — the reason this module already gave for
  // `voice-sender`, applied to the other three instead of only to that one.
  const myCwd = 'F:\\workspace\\projects\\rush-breaker';
  assert.deepEqual(cap.deriveCapabilities({ cwd: myCwd }), [],
    'the cwd that used to designate rush-breaker must now designate nothing');
  // It is not enough that the answer is right: the same lane must not be
  // reachable through any spelling of the path either.
  assert.deepEqual(cap.deriveCapabilities({ cwd: 'f:/workspace/projects/RUSH-BREAKER' }), []);
  assert.deepEqual(cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\cacioverse' }), [],
    'cacioverse was derived the same way, and it is wrong for Pam too — her lane is two directories');
  assert.deepEqual(cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\munder-difflin' }), [],
    'and office-dev: the office directory is where Jim and Kelly were born, not a job');
});

test('the system assigns from isGod, and never from prose', () => {
  assert.deepEqual(cap.deriveCapabilities({ isGod: true }), ['orchestrator']);
  // An agent with no facts is not designated for anything. "Nobody" is an answer
  // this module already makes deliberately, for `voice-sender`.
  assert.deepEqual(cap.deriveCapabilities({}), []);
  // And a role in any language cannot leak in, because the signature has no slot
  // for it. `role` is for people; nothing automatic reads it.
  assert.equal(cap.deriveCapabilities.length, 1);
});

test('every lane capability is declared not-derivable, each with its own counterexample', () => {
  // Silence would pass the closure test below and teach nothing, so this pins
  // the part that carries the information: the three reasons are not one reason
  // written three times. Each one names the agent it used to get wrong, and all
  // three agents are named in hive/lanes.mjs with a DIFFERENT lane.
  const reasonFor = (c) => {
    const d = cap.NOT_DERIVABLE.find((x) => x.capability === c);
    assert.ok(d, `${c} must be declared not-derivable, not silently absent`);
    return d.because;
  };
  assert.match(reasonFor('rush-breaker'), /jim-mugp1eoh/,
    'the rush-breaker reason is its counterexample: cwd is the office lane');
  assert.match(reasonFor('office-dev'), /kelly-multwfg2/,
    'the office-dev reason is its counterexample: the office dir is the voice lane');
  assert.match(reasonFor('cacioverse'), /pam-mul0lzyj/,
    'the cacioverse reason is its counterexample: a lane can be two directories');
  for (const c of ['office-dev', 'rush-breaker', 'cacioverse']) {
    assert.match(reasonFor(c), /hive\/lanes\.mjs/,
      `${c} must say WHERE the declaration lives, so the next reader knows where to fix it`);
  }
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

test('the office lane is declared, not derived: munder-difflin is a place, not a job', () => {
  // The same table had the bug in every row. `munder-difflin` designated
  // kelly-multwfg2 — whose lane is munder-difflin but whose work is the voice —
  // and god. The comment this test used to carry said "munder-difflin IS the
  // office, so office-dev is not a judgement call": true about the DIRECTORY,
  // and irrelevant, because the question is about a PERSON. A directory
  // designates whoever was started in it, which on this floor is the office
  // developer AND the voice sender AND the orchestrator.
  assert.deepEqual(cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\munder-difflin' }), []);
  assert.deepEqual(cap.deriveCapabilities({ cwd: 'f:/workspace/projects/MUNDER-DIFFLIN' }), [],
    'the lane does not care how the path is spelled — it is not read at all');
});

test('a hole in the derivation table is impossible to leave quietly', () => {
  // The general form of the bug above: every capability must either come out of
  // some derivation, or be named in NOT_DERIVABLE with a reason. A capability
  // that is neither is a question with no answer and nobody holding it.
  //
  // The sample inputs are DELIBERATELY the ones the old table used to derive
  // from, and they now produce nothing: so this test is also a regression on
  // that table coming back, and the four other capabilities can only be covered
  // by a declared reason. Before this change the same test passed for the
  // opposite reason, which is what made the defect quiet.
  const lanes = [
    { isGod: true },                                            // orchestrator
    { cwd: 'F:\\workspace\\projects\\munder-difflin' },          // used to be office-dev
    { cwd: 'F:\\workspace\\projects\\cacioverse' },              // used to be cacioverse
    { cwd: 'F:\\workspace\\projects\\rush-breaker' }             // used to be rush-breaker
  ];
  const derivable = new Set(lanes.flatMap((m) => cap.deriveCapabilities(m)));
  const declared = new Set(cap.NOT_DERIVABLE.map((d) => d.capability));
  assert.deepEqual([...derivable], ['orchestrator'],
    'only isGod designates anything; a directory designates nobody');
  for (const c of cap.CAPABILITIES) {
    const covered = derivable.has(c) || declared.has(c);
    assert.ok(covered,
      `"${c}" is neither derived from any lane nor listed in NOT_DERIVABLE. `
      + 'Add the lane, or record why it cannot be derived — a hole in the table is a hole in the answer.');
  }
  // And a reason is not optional: an entry with an empty `because` is a hole
  // with paperwork.
  for (const d of cap.NOT_DERIVABLE) {
    assert.ok(d.because && d.because.length > 20, `${d.capability} needs a real reason, not a placeholder`);
  }
});

test('cwd does NOT designate voice-sender, and the floor proves why', () => {
  // The same table had the bug in the other direction, which is worse than the
  // hole: it put `munder-difflin -> voice-sender`, so the office DEVELOPER would
  // have been designated the voice sender. On 2026-09-28 two agents sat in that
  // one directory and only one sent voice messages, so a directory cannot tell
  // them apart — and designating both is the "two correct answers" failure this
  // field exists to remove.
  const dev = cap.deriveCapabilities({ cwd: 'F:\\workspace\\projects\\munder-difflin' });
  assert.ok(!dev.includes('voice-sender'), 'the office developer is not the voice sender');
  const why = cap.NOT_DERIVABLE.find((d) => d.capability === 'voice-sender');
  assert.ok(why, 'and voice-sender must be declared not-derivable, not silently absent');
  assert.match(why.because, /munder-difflin/, 'the reason is the counterexample, and it must name it');
});

test('"who should send the voice messages" is still answerable when someone is designated', () => {
  // Being not-derivable is not the same as unanswerable: the designation can
  // still be made, it just cannot be guessed. This keeps the mechanism honest
  // in both directions.
  const roster = [{ id: 'kelly-multwfg2', capabilities: ['voice-sender'], archived: false }];
  const r = cap.whoShouldDo(roster, 'voice-sender', { agentFolderExists: onDisk('kelly-multwfg2') });
  assert.deepEqual(r.agents, ['kelly-multwfg2']);
  // And with nobody designated, it is nobody — the honest answer, not a guess
  // at whoever happens to be in the office.
  const undesignated = cap.whoShouldDo(
    [{ id: 'jim-mugp1eoh', capabilities: ['office-dev'], archived: false }],
    'voice-sender', { agentFolderExists: onDisk('jim-mugp1eoh') });
  assert.deepEqual(undesignated.agents, []);
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
