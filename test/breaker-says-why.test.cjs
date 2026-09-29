'use strict';
/**
 * 063: does the breaker, when it trips, name the fact that made it trip?
 *
 * The card's two directions, both of which must lose in both directions:
 *   1. the breaker that trips must say WHY, including the part it could not see;
 *   2. the fact that does NOT trip must still say so.
 *
 * What the measurement found: `unidentifiedToolUses` was appended to the LOOPING
 * reason only. But a call with no tool_input is never compared, so it never
 * increments repeatCount, so the loop arm can never fire for an agent whose
 * calls are all invisible — which is the only reader of the count. The counter
 * could be incremented and never printed. It was write-only.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');

const SRC = path.join(__dirname, '..', 'src', 'main', 'breaker.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-says-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'breaker.js'), js, 'utf8');
const { CircuitBreaker } = require(path.join(out, 'breaker.js'));

const UNSEEN = /NO tool_input/;

function makeBreaker(over = {}) {
  return new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 60000, ...over
  }));
}
const sample = (agentId, ts, output, input = 1000) =>
  ({ agentId, sessionId: 's1', ts, input, output, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 });
const beat = (b, agentId, s = sample(agentId, 1, 100)) => b.tick([{ agentId, sample: s, progressing: true }], 2000)[0];

/** Feed `n` calls that carry no tool_input at all. */
const feedUnseen = (b, agentId, n) => {
  for (let i = 0; i < n; i++) b.recordToolUse(agentId, 'Bash', undefined, 1000 + i);
};

test('DIRECTION 2: a wall of invisible calls counts, and the count is real', () => {
  const b = makeBreaker();
  feedUnseen(b, 'jim', 40);
  assert.equal(b.agents.get('jim').unidentifiedToolUses, 40, 'every invisible call must be counted');
});

test('DIRECTION 2: an agent whose calls are ALL invisible does not trip, and that is the design', () => {
  // "the harness never sends input" is indistinguishable from "the agent is
  // looping invisibly", so tripping on it could stop a healthy worker. The
  // correct answer is NOT to invent that trip — it is to make sure the fact is
  // visible wherever the state is reported.
  const b = makeBreaker();
  feedUnseen(b, 'jim', 500);
  assert.equal(b.levelFor('jim'), 'healthy', 'invisible calls alone must not trip the loop arm');
});

test('DIRECTION 1: when the loop arm trips, the reason names the invisible calls too', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('jim', 'Bash', { command: 'same' }, 1000 + i);
  feedUnseen(b, 'jim', 12);
  const d = beat(b, 'jim');
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/, 'the reason names the arm that fired');
  assert.match(d.state.reason, UNSEEN, 'AND the calls it could not see — this is what used to be reachable only here');
  assert.match(d.state.reason, /12 call\(s\)/, 'with the real number');
});

test('DIRECTION 1: EVERY arm carries the invisible-call count, not just the loop arm', () => {
  // The defect, precisely. Six arms can trip and every one of them used to drop
  // the fact, so an operator reading an error-storm trip had no way to know that
  // 40 calls in the same window were invisible.
  const b = makeBreaker();
  feedUnseen(b, 'jim', 7);
  for (let i = 0; i < 5; i++) b.recordError?.('jim');
  const d = beat(b, 'jim');
  assert.equal(d.state.level, 'steering', `the error arm must still fire: ${d.state.reason}`);
  assert.match(d.state.reason, /error storm/, 'the arm that fired is named');
  assert.match(d.state.reason, UNSEEN, 'and so is the part of the window nobody could see');
});

test('the token-limit arm carries it too, since it is a per-agent fact', () => {
  const b = makeBreaker({ agentTokenCaps: { jim: 100 } });
  feedUnseen(b, 'jim', 3);
  const d = beat(b, 'jim', sample('jim', Date.now(), 100, 5000));
  assert.equal(d.state.level, 'steering', `the token arm must fire: ${d.state.reason}`);
  assert.match(d.state.reason, /token limit/, 'the arm is named');
  assert.match(d.state.reason, UNSEEN, 'and the invisible calls ride along');
});

test('a healthy agent with no invisible calls says nothing extra', () => {
  // The suffix must not appear when there is nothing to say, or every reason on
  // the floor gains a clause that means nothing and trains people to skip it.
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('jim', 'Bash', { command: 'same' }, 1000 + i);
  const d = beat(b, 'jim');
  assert.match(d.state.reason, /looping/);
  assert.doesNotMatch(d.state.reason, UNSEEN, 'no invisible calls, so no clause about them');
});

test('a loop of REAL but empty input is still a loop, and is not called invisible', () => {
  // The distinction that has to survive: `{}` is a real value that WAS compared.
  // Only undefined/null mean "the input never arrived".
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('jim', 'Bash', {}, 1000 + i);
  const d = beat(b, 'jim');
  assert.equal(d.state.level, 'steering');
  assert.doesNotMatch(d.state.reason, UNSEEN, 'an empty object is a value, not an absence');
});

test('the count is in every reason the breaker can produce, and no arm was left behind', () => {
  // Structural, because the behavioural cases above can only cover the arms I
  // thought to write a case for. Seven arms exist; a literal `tripping: true`
  // outside the single `trip()` helper would be an arm that drops the fact again.
  const src = fs.readFileSync(SRC, 'utf8');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const literals = (code.match(/tripping:\s*true/g) || []).length;
  const helper = (code.match(/\(\{\s*tripping:\s*true/g) || []).length;
  assert.equal(literals - helper, 0,
    'every tripping return must go through the helper that appends the invisible-call count');
  assert.equal((code.match(/return trip\(/g) || []).length, 7, 'all seven arms route through trip()');
});
