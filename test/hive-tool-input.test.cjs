'use strict';
/**
 * task-jim-059 — the producer never wrote `tool_input`, so the loop detector was
 * blind to every agent on this floor.
 *
 * THE DEFECT. `hooks.ts:208` feeds the breaker with
 * `recordToolUse(agentId, p.tool_name, p.tool_input)`. The opencode hook bridge
 * (`hive.ts`, `tool.execute.after`) posted `hook_event_name` and `tool_name` and
 * never `tool_input`. `registry.json` says `provider: opencode` for god, Jim and
 * Pam, so *every* tool call of *every* agent on the floor arrived with the term
 * the comparison needs missing. `breaker.recordToolUse` then took its
 * unidentified-input arm for all of them: `unidentifiedToolUses` climbed, the
 * repeat counter never moved, and the guard that is supposed to catch our loops
 * could not see a single one of them.
 *
 * THE TWO THINGS THAT HAD TO BE TRUE, and why testing only the first is how you
 * ship this half-fixed:
 *   1. the producer emits `tool_input`  — from the right place. For
 *      `tool.execute.after` that is `input.args`; for `tool.execute.before` the
 *      args arrive on the SECOND parameter, not on `input`. Getting only 3052
 *      moves the hole instead of closing it.
 *   2. the value is COMPARABLE. `?? {}` is load-bearing, not tidiness: without
 *      it a tool called with no arguments still sends nothing, because
 *      `JSON.stringify` elides an `undefined` value rather than writing `null`.
 *      And `{}` is a real, comparable value for the breaker — only `undefined`
 *      and `null` are not.
 *
 * PLUS the trip format is pinned, because the failure this card is really about
 * is a format that drifted: the reason string on the floor and the string in
 * `breaker.ts` disagreed, and nobody noticed for hours because nobody compared
 * them. So these tests assert the key in the MESSAGE equals the key the CODE
 * computes for the same input — not a digest copied into the test file, which
 * would pass forever while the real format rotted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const HIVE_TS = path.join(ROOT, 'src', 'main', 'hive.ts');
const hiveSrc = fs.readFileSync(HIVE_TS, 'utf8');

/** breaker.ts has only type-only imports, so it transpiles standalone. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-059-'));
fs.writeFileSync(path.join(tmp, 'breaker.js'), ts.transpileModule(
  fs.readFileSync(path.join(ROOT, 'src', 'main', 'breaker.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText, 'utf8');
const { CircuitBreaker } = require(path.join(tmp, 'breaker.js'));

// ── extracting the real expressions out of the source ────────────────────────

/**
 * Brace-match an object literal starting at `start`, skipping over string
 * literals so a brace inside a string cannot end the scan early. `{}` inside the
 * literal is balanced, so plain counting is fine once strings are skipped.
 */
function objectAt(src, start) {
  let depth = 0, i = start, quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced object literal');
}

/** The object literal a `post({...})` call sends, located from an anchor. */
function postedPayload(anchor) {
  const a = hiveSrc.indexOf(anchor);
  assert.notEqual(a, -1, 'anchor not present in hive.ts: ' + anchor);
  const p = hiveSrc.indexOf('post(', a);
  assert.notEqual(p, -1, 'no post() after anchor: ' + anchor);
  const brace = hiveSrc.indexOf('{', p);
  return objectAt(hiveSrc, brace);
}

/** Compile a real object literal from the source into a callable. */
function evaluator(src, names) {
  return new Function(...names, 'return ' + src);
}

const afterLiteral = postedPayload("'tool.execute.after': async");
const beforeLiteral = postedPayload("'tool.execute.before': async");
const piResultLiteral = postedPayload("pi.on('tool_result'");
const piCallLiteral = postedPayload("pi.on('tool_call'");

const sendAfter = evaluator(afterLiteral, ['input', 'output']);
const sendBefore = evaluator(beforeLiteral, ['input', 'output']);
const sendPiResult = evaluator(piResultLiteral, ['ev', 'input', 'output']);
const sendPiCall = evaluator(piCallLiteral, ['ev', 'AUTO']);

// the agy shim builds `payload` rather than calling post(). Anchor on the
// declaration itself: `agy.toolCall || {}` also contains braces, and grabbing
// that one yields an empty object that trivially has no tool_input.
const agyAnchor = hiveSrc.indexOf('const tc = agy.toolCall');
assert.notEqual(agyAnchor, -1, 'agy shim not found in hive.ts');
const agyPayloadDecl = hiveSrc.indexOf('const payload =', agyAnchor);
assert.notEqual(agyPayloadDecl, -1, 'agy payload object not found in hive.ts');
const agyPayloadLiteral = objectAt(hiveSrc, hiveSrc.indexOf('{', agyPayloadDecl));
const buildAgy = evaluator(agyPayloadLiteral, ['event', 'agentId', 'agy', 'tc']);

// ── 1. the producer emits tool_input, from the right place ───────────────────

test('tool.execute.after sends the real args as tool_input', () => {
  const args = { command: 'git status', timeout: 5000 };
  const p = sendAfter({ tool: 'bash', args }, undefined);
  assert.equal(p.hook_event_name, 'PostToolUse');
  assert.equal(p.tool_name, 'bash');
  assert.deepEqual(p.tool_input, args, 'after: tool_input must be input.args');
});

test('tool.execute.before takes the args from the SECOND parameter', () => {
  const args = { filePath: 'a.ts' };
  // Deliberately give `input` a DIFFERENT args object: if the bridge read
  // input.args this test fails, which is the point of writing it.
  const p = sendBefore({ tool: 'read' }, { args });
  assert.equal(p.hook_event_name, 'PreToolUse');
  assert.deepEqual(p.tool_input, args, 'before: args live on the output parameter');
});

test('every PostToolUse producer on the floor carries tool_input', () => {
  const p = sendPiResult({ name: 'read', args: { path: 'x' } });
  assert.deepEqual(p.tool_input, { path: 'x' }, 'pi tool_result lost the input');
});

test('the pi tool_call producer carries tool_input too, like its own sibling', () => {
  // Two lines apart in the same emitted string, one with the `?? {}` and one
  // without. Nothing pins them to each other, so the pair drifted and the
  // PreToolUse key was ELIDED by JSON.stringify — the key simply never reached
  // the socket, with nothing in the payload saying it was missing.
  const p = sendPiCall({ name: 'read', args: { path: 'x' } }, false);
  assert.deepEqual(p.tool_input, { path: 'x' }, 'pi tool_call lost the input');
});

test('the two pi producers cannot disagree about the same event', () => {
  // The invariant, stated once so it holds for every future edit: the two hooks
  // in one extension present the SAME shape for the SAME event object. A
  // disagreement here is invisible downstream — one caller sees a value and the
  // other sees a hole, and both read as "no input".
  for (const ev of [
    { name: 'read', args: { path: 'x' } },
    { name: 'read' },                    // no args at all
    { name: 'read', args: null, input: { q: 1 } },
    { name: 'read', args: undefined },
    {}                                    // a bare event
  ]) {
    const pre = sendPiCall(ev, false);
    const post = sendPiResult(ev);
    assert.equal('tool_input' in pre, 'tool_input' in post,
      `the key is present on one hook and absent on the other for ${JSON.stringify(ev)}`);
    assert.deepEqual(pre.tool_input, post.tool_input,
      `the two hooks disagree about the value for ${JSON.stringify(ev)}`);
  }
});

test('a pi tool_call with no args still sends the KEY, and survives the wire', () => {
  // The elision is the whole defect: `tool_input: ev && (ev.args || ev.input)`
  // evaluates to undefined, and JSON.stringify DROPS an undefined key rather
  // than sending a null. So the receiver gets a payload with a hole, and cannot
  // tell that from a field that does not exist.
  const p = sendPiCall({ name: 'todo' }, false);
  assert.ok('tool_input' in p, 'the key must be present, not dropped by stringify');
  assert.deepEqual(p.tool_input, {}, 'missing args must normalise to {}');
  assert.ok(JSON.stringify(p).includes('"tool_input":{}'), 'and must survive the wire');
});

test('a pi tool_call with NO EVENT OBJECT at all still sends a comparable value', () => {
  // `ev` can be absent entirely on this API (the sibling already guards for it,
  // which is how the asymmetry was visible in the first place).
  for (const ev of [undefined, null]) {
    const p = sendPiCall(ev, false);
    assert.notEqual(p.tool_input, undefined, `ev=${ev}: undefined is NOT comparable`);
    assert.notEqual(p.tool_input, null, `ev=${ev}: null is NOT comparable`);
    assert.ok('tool_input' in p, `ev=${ev}: the key must still reach the wire`);
  }
});

test('a tool with no arguments still sends a COMPARABLE value, not nothing', () => {
  // The subtle one. `tool_input: tc.args` with args undefined is ELIDED by
  // JSON.stringify, so the key never reaches the socket and the breaker is
  // blind again — for exactly the tools that take no arguments.
  const p = buildAgy('PostToolUse', 'god', {}, { name: 'now' });
  assert.ok('tool_input' in p, 'the key must be present, not dropped by stringify');
  assert.deepEqual(p.tool_input, {}, 'missing args must normalise to {}');
  assert.ok(JSON.stringify(p).includes('"tool_input":{}'), 'and must survive the wire');
});

test('a call with no args anywhere is still comparable end to end', () => {
  for (const [label, payload] of [
    ['after', sendAfter({ tool: 'todo' }, undefined)],
    ['before', sendBefore({ tool: 'todo' }, {})],
    ['pi result', sendPiResult({ name: 'todo' })],
    ['pi call', sendPiCall({ name: 'todo' }, false)]
  ]) {
    assert.notEqual(payload.tool_input, undefined, label + ': undefined is NOT comparable');
    assert.notEqual(payload.tool_input, null, label + ': null is NOT comparable');
  }
});

// ── 2. the fix restores the breaker's sight, on the real breaker ────────────

function makeBreaker(over = {}) {
  return new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 60000, ...over
  }));
}
const T0 = 1_000_000_000_000;
const sample = (agentId, ts) => ({ agentId, sessionId: 's1', ts, input: 1000, output: 100, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 });

/** Drive the breaker the way hooks.ts:208 does, with a real shim payload. */
function feed(b, agentId, payload, times) {
  for (let i = 0; i < times; i++) b.recordToolUse(agentId, payload.tool_name, payload.tool_input);
}
function beat(b, agentId) {
  return b.tick([{ agentId, sessionId: 's1', sample: sample(agentId, T0), progressing: true }], T0)[0];
}

test('DIFFERENT tool calls are no longer all one identical call', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) {
    // A real working agent: same tool, different command every time.
    feed(b, 'god', sendAfter({ tool: 'bash', args: { command: 'ls -' + i } }), 1);
  }
  const d = beat(b, 'god');
  assert.notEqual(d.state.level, 'steering',
    'varied work must not read as a loop — this is the false positive the old input produced');
  assert.equal(b.levelFor('god'), 'healthy');
});

test('a REAL loop still trips, now that the input reaches the breaker', () => {
  const b = makeBreaker();
  const stuck = sendAfter({ tool: 'bash', args: { command: 'same' } });
  feed(b, 'jim', stuck, 8);
  const d = beat(b, 'jim');
  assert.equal(d.state.level, 'steering', 'a genuine repeat must still be caught');
  assert.match(d.state.reason, /looping/);
});

test('no call is reported as unidentified any more', () => {
  const b = makeBreaker();
  feed(b, 'pam', sendAfter({ tool: 'read', args: { path: 'p' } }), 3);
  assert.equal(b.agents.get('pam').unidentifiedToolUses, 0,
    'every call must be comparable: an unidentified call is a call the guard cannot see');
});

// ── 3. the trip format is pinned to the code, not to a copied digest ─────────

test('the trip key is exactly name:16-hex — the format breaker.ts:263 produces', () => {
  const b = makeBreaker();
  const key = b.toolKey('bash', { command: 'x' });
  assert.match(key, /^[A-Za-z0-9_.:-]+:[0-9a-f]{16}$/,
    'the format drifted from name:digest; the reason strings on the floor stop parsing');
  assert.equal(key.split(':').length, 2, 'exactly one colon: the name and the digest');
});

test('the digest in the MESSAGE is the digest the CODE computes for that input', () => {
  // This is the assertion that would have caught the hours-long drift: it
  // recomputes from the code and compares to what the message says, rather
  // than comparing the message to a literal baked into this file.
  const b = makeBreaker();
  const args = { command: 'stuck' };
  feed(b, 'god', sendAfter({ tool: 'bash', args }), 8);
  const d = beat(b, 'god');
  const m = d.state.reason.match(/identical tool call \(([^)]+)\)/);
  assert.ok(m, 'the reason must name the offending call: ' + d.state.reason);
  assert.equal(m[1], b.toolKey('bash', args),
    'the key in the message must be the key the code computes — a copied digest proves nothing');
  assert.equal(m[1], 'bash:' + m[1].split(':')[1], 'name and digest stay in their halves');
});

test('two different inputs must not share a digest — the empty-input signature', () => {
  const b = makeBreaker();
  // e3b0c442... is the SHA-256 of nothing. Before the fix EVERY call hashed to
  // it, which is what turned 8 tool calls into a loop.
  const a = b.toolKey('bash', { command: 'one' });
  const c = b.toolKey('bash', { command: 'two' });
  assert.notEqual(a, c, 'distinct inputs collapsed to one key: the empty-input signature is back');
  assert.notEqual(a.split(':')[1], 'e3b0c44298fc1c1499f8c5d8c9a', 'must not be the digest of nothing');
  assert.equal(b.toolKey('bash', { command: 'one' }), a, 'but the same input must still be equal');
});
