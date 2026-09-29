'use strict';

/**
 * There is ONE Vocal Sender, it lives in the repository, and this file says so
 * in the positive.
 *
 * THE HISTORY, because the test is its consequence and not its decoration.
 *
 * Every agent used to carry its own copy of `voice-outbox.mjs` under
 * `.claude/skills/`. They diverged: one copy ran 720 lines with a 600-character
 * ceiling and no splitter, the repo ran 1064 with both. So the lane the user was
 * listening to was a DIFFERENT PROGRAM from the one in the repository, and nothing
 * anywhere said so. Two copies of one program always diverge — that is not a
 * discipline problem, it is what a copy is — so "keep them aligned" was never the
 * fix. Aligning them is a habit, and a habit has not once been right by
 * construction.
 *
 * SO THE COPIES ARE GONE, and this asserts the thing that is true afterwards:
 *
 *   1. the script the lane runs IS the file in the repository
 *   2. no second copy of it exists anywhere in the hive
 *   3. the skill says to run the repository file, not a private one
 *   4. any SKILL.md still lying around matches the repository's
 *
 * This is a POSITIVE assertion on purpose. The earlier version compared every
 * agent's copy to the repo, which could only ever end red — and a guard that
 * stands red forever is a guard people learn to scroll past. A uniqueness claim
 * can be green forever, and when it does go red it means something real: a
 * fallback came back, and the route that speaks is no longer the route in the repo.
 *
 * It also stops depending on a hand-written list of who executes what. A test
 * that needs to be told which agents are allowed to speak is one list away from
 * being wrong, and being wrong there is invisible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_DIR = path.join(__dirname, '..', 'resources', 'skills', 'md-voice-brief');
const SCRIPT = 'voice-outbox.mjs';
const SKILL = 'SKILL.md';
/** The skill this file is about. The other seventeen have their own business. */
const LANE_SKILL = 'md-voice-brief';

/** Directories a stray copy must never hide in, and a floor under the walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', 'tmp']);
const MAX_DEPTH = 12;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Where the agents' trees are, or null on a machine that has none. */
function findLaneRoot() {
  const candidates = [];
  if (process.env.HIVE_ROOT) candidates.push(path.resolve(process.env.HIVE_ROOT));
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 6; i++) { candidates.push(path.join(dir, 'hive')); candidates.push(dir); dir = path.dirname(dir); }
  for (const c of candidates) {
    const agents = path.join(c, 'agents');
    if (!isDir(agents)) continue;
    if (fs.readdirSync(agents).some((n) => isDir(path.join(agents, n)))) return c;
  }
  return null;
}

/** Every skill directory under the agents' trees, with the agent it belongs to. */
function skillsUnder(laneRoot) {
  const found = [];
  const agents = path.join(laneRoot, 'agents');
  let ids;
  try { ids = fs.readdirSync(agents, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return found; }
  for (const a of ids) {
    const skills = path.join(agents, a.name, '.claude', 'skills');
    let dirs;
    try { dirs = fs.readdirSync(skills, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const d of dirs) found.push({ agent: a.name, skill: d.name, dir: path.join(skills, d.name) });
  }
  return found;
}

/** Every copy of `fileName` under the agents' trees, with the agent it belongs to. */
function copiesUnder(laneRoot, fileName) {
  const found = [];
  const walk = (dir, agent, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) {
        // `.claude` is the one dot-directory worth walking: that is where a copy
        // would have been put. Anything else starting with a dot is machinery.
        if (e.name === '.claude') walk(path.join(dir, e.name), agent, depth + 1);
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const next = agent || e.name;
        walk(path.join(dir, e.name), next, depth + 1);
        continue;
      }
      if (e.name === fileName) found.push({ agent: agent || '(root)', file: path.join(dir, e.name) });
    }
  };
  walk(path.join(laneRoot, 'agents'), null, 0);
  return found;
}

test('the speaking script IS the file in the repository, and it loads', async () => {
  const file = path.join(REPO_DIR, SCRIPT);
  assert.ok(fs.existsSync(file), `the repository must carry ${SCRIPT}`);
  assert.equal(sha256(file).length, 64);
  // Loading it is part of the claim: a script that cannot even be imported is not
  // the script anything is running.
  const mod = await import(require('node:url').pathToFileURL(file).href);
  assert.equal(typeof mod.flushOne, 'function');
  assert.equal(typeof mod.writeReceipt, 'function');
});

test('the skill tells you to run the repository file, not a private copy', () => {
  const text = fs.readFileSync(path.join(REPO_DIR, SKILL), 'utf8');
  assert.match(text, /resources\/skills\/md-voice-brief\/voice-outbox\.mjs/,
    'the skill must name where the script actually lives');
  assert.doesNotMatch(text, /node "\$AGENT_DIR\/\.claude\/skills\/[^"]*voice-outbox\.mjs"/,
    'and must not tell anyone to run a copy out of an agent folder — that is the path that let the two drift apart');
  assert.match(text, /VOICE_OUTBOX=/, 'the path is set once and used for all three steps');
});

test('no second copy of the script exists anywhere in the agents\' trees', (t) => {
  const lane = findLaneRoot();
  if (!lane) { t.skip(`no hive found (HIVE_ROOT=${process.env.HIVE_ROOT || 'unset'}) — nothing to compare, so nothing is asserted`); return; }

  const strays = copiesUnder(lane, SCRIPT).filter((c) => path.resolve(c.file) !== path.resolve(path.join(REPO_DIR, SCRIPT)));
  assert.deepEqual(strays, [], [
    'the Vocal Sender must exist once, in the repository. These are copies of it:',
    ...strays.map((c) => `  ${c.agent}: ${c.file}`),
    'a fallback that behaves like the real thing is worse than no fallback, because nothing tells you which one you ran.',
  ].join('\n'));
});

test("the voice lane's own instructions match the repository's, wherever they survive", (t) => {
  // THE REFERENCE IS PER SKILL, and this test used to get that wrong in a way
  // that could only ever be red: it walked every `SKILL.md` in every agent's
  // folder and compared them all against the VOICE lane's copy. There are eighteen
  // skills in this repo and four agents, so it was comparing `capabilities` and
  // `temporal` against `md-voice-brief` — two different documents, which is not a
  // divergence, it is a category error.
  //
  // So the fix is not "compare fewer files". It is to resolve each copy against
  // the repository file of ITS OWN skill: `agents/<id>/.claude/skills/<skill>/`
  // against `resources/skills/<skill>/`.
  //
  // And the assertion stays scoped to the voice lane, because this file is about
  // the voice lane. A check that also decided every other agent's skills must be
  // byte-identical to the repository would be imposing a policy nobody has
  // declared — and an agent legitimately editing one of its own skills would then
  // go red on somebody else's card.
  const lane = findLaneRoot();
  if (!lane) { t.skip('no hive found'); return; }

  const mine = skillsUnder(lane).filter((s) => s.skill === LANE_SKILL);
  const want = sha256(path.join(REPO_DIR, SKILL));

  // Absence is fine — an agent with no private skill has no fallback to go stale.
  // A PRESENT but divergent one is the problem: it is the instructions, and stale
  // instructions are how an agent ends up running a file that is not there.
  const stale = mine
    .map((s) => ({ ...s, hash: fs.existsSync(path.join(s.dir, SKILL)) ? sha256(path.join(s.dir, SKILL)) : null }))
    .filter((s) => s.hash !== null && s.hash !== want);

  assert.deepEqual(
    stale.map((s) => `${s.agent}/${LANE_SKILL}/SKILL.md (${s.hash.slice(0, 12)}, repo is ${want.slice(0, 12)})`),
    [],
    'a leftover SKILL.md that no longer matches the repository will send someone to a script that is not there'
  );
});

test('the per-skill reference does not confuse one skill for another', () => {
  // The bug this pins, on a fixture, because the real tree is clean and a guard
  // only ever seen against a clean tree has never been seen to work. Two skills,
  // two repository files, one reference each — and a copy of the WRONG one has to
  // come out as stale rather than quietly matching.
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vo-skill-'));
  const repoSkills = path.join(root, 'resources', 'skills');
  const laneSkills = path.join(root, 'agents', 'someone', '.claude', 'skills');
  for (const [name, body] of [['md-voice-brief', 'voice\n'], ['temporal', 'time\n']]) {
    fs.mkdirSync(path.join(repoSkills, name), { recursive: true });
    fs.writeFileSync(path.join(repoSkills, name, SKILL), body, 'utf8');
  }
  for (const [name, body] of [['md-voice-brief', 'voice\n'], ['temporal', 'voice\n']]) {
    fs.mkdirSync(path.join(laneSkills, name), { recursive: true });
    fs.writeFileSync(path.join(laneSkills, name, SKILL), body, 'utf8');
  }

  const skills = skillsUnder(root);
  assert.deepEqual(skills.map((s) => `${s.agent}/${s.skill}`), ['someone/md-voice-brief', 'someone/temporal']);

  // The right reference per skill: temporal's copy holds the voice file's text, so
  // resolving it against `resources/skills/md-voice-brief` would call it correct.
  const perSkill = (name) => sha256(path.join(repoSkills, name, SKILL));
  assert.notEqual(perSkill('md-voice-brief'), perSkill('temporal'),
    'the two repository files really are different documents');

  const stale = skills.filter((s) => sha256(path.join(s.dir, SKILL)) !== perSkill(s.skill));
  assert.deepEqual(stale.map((s) => s.skill), ['temporal'],
    'a copy holding another skill\'s text must read as stale — this is the case the old reference called correct');
});

test('the guard still fails when a second copy exists', () => {
  // A uniqueness claim that cannot fail is a comment. This proves it on a
  // fixture, because the real tree is the thing that is supposed to be clean —
  // and a guard tested only against a clean tree is a guard that has never been
  // seen to work.
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vo-lane-'));
  const laneAgents = path.join(root, 'agents');
  const dir = path.join(laneAgents, 'someone', '.claude', 'skills', 'md-voice-brief');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SCRIPT), 'a copy\n', 'utf8');
  fs.writeFileSync(path.join(dir, SKILL), fs.readFileSync(path.join(REPO_DIR, SKILL)));

  const strays = copiesUnder(root, SCRIPT);
  assert.equal(strays.length, 1, 'the copy must be found');
  assert.equal(strays[0].agent, 'someone', 'and attributed to the agent it belongs to, not to a dot-directory');

  fs.unlinkSync(path.join(dir, SCRIPT));
  assert.deepEqual(copiesUnder(root, SCRIPT), [], 'and gone once it is gone');
});
