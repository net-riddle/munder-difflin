'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs,
  CODEX_REMOTE_SOCKET_MAX,
  CODEX_REMOTE_SOCKET_RELATIVE
} = loadTs('src/shared/codexRemote.ts');

// Codex remote is POSIX-only BY PRODUCT DECISION, and the product says so in one
// line: `src/main/index.ts:163` returns false on `win32` before an alias or an
// endpoint is ever computed. So on Windows this module is exercised as pure
// functions and nothing more.
//
// Both the module and this file arrived in ONE commit — 33317a2c, 2026-07-27 —
// which is also the commit that added that platform gate. So there is no "the
// product changed" and no "the expectation lagged": the POSIX endpoint spelling
// and the refusal to build one on Windows were written together, and this file
// simply asserted the first without carrying the second.
const REMOTE_IS_POSIX_ONLY = process.platform === 'win32';
const POSIX_ONLY_SKIP =
  'Codex remote refuses to run on Windows by design (src/main/index.ts:163 returns false on win32), so no endpoint is ever built there and its spelling is not a fact this platform can be asked about';

test('Codex remote uses a short stable per-agent home alias', () => {
  // The ALIAS is platform-independent: same input, same output; a different agent
  // gets a different one; and it stays inside the length budget. Those three
  // claims hold here and are the subject of the test.
  const first = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const again = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const other = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-2', '/tmp');
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.ok(first.length < 80);
});

test('the endpoint is a unix socket URL under the alias root it was given', { skip: REMOTE_IS_POSIX_ONLY ? POSIX_ONLY_SKIP : false }, () => {
  const first = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  assert.match(codexRemoteEndpoint(first), /^unix:\/\/\/tmp\//);
});

test('the endpoint is scheme-prefixed on every platform, even where it is never used', () => {
  // Worth pinning separately, because it is true everywhere and it is what a
  // caller would break first: the `unix://` scheme is not the platform-dependent
  // part of the endpoint, the SEPARATOR is. `join` is `node:path`'s, so on Windows
  // the path inside comes back with backslashes — which is exactly why the
  // spelling above is asserted only where the value is ever built.
  const first = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  const endpoint = codexRemoteEndpoint(first);
  assert.ok(endpoint.startsWith('unix://'), `the scheme must survive everywhere, got ${endpoint}`);
  assert.ok(endpoint.length < CODEX_REMOTE_SOCKET_MAX, `and the whole endpoint stays inside sun_path: ${endpoint.length} bytes`);
  assert.ok(
    endpoint.endsWith(path.join('', CODEX_REMOTE_SOCKET_RELATIVE)) || endpoint.endsWith(CODEX_REMOTE_SOCKET_RELATIVE),
    `and still ends at the socket it points to: ${endpoint}`
  );
});

test('the default alias root yields a socket within sun_path', () => {
  // The real hive home that failed with "path must be shorter than SUN_LEN".
  const realHome =
    '/Users/vyapakgoyal/Documents/HarnessAgents/hive/agents/dev2-mrxb3l43/.codex';
  const socket =
    codexRemoteAliasPath(realHome, 'dev2-mrxb3l43') + '/' + CODEX_REMOTE_SOCKET_RELATIVE;
  assert.ok(
    socket.length < CODEX_REMOTE_SOCKET_MAX,
    `socket path is ${socket.length} bytes: ${socket}`
  );
  // …and shorter than the home it replaces, which the $TMPDIR version was not.
  assert.ok(socket.length < (realHome + '/' + CODEX_REMOTE_SOCKET_RELATIVE).length);
});

test('an over-long alias root is rejected instead of failing at bind time', () => {
  const tmpdirStyle = '/var/folders/v6/9f10q5d148z7bxdzhr22xl7r0000gn/T/munder-codex';
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a', tmpdirStyle)), false);
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a')), true);
});

test('remote endpoint precedes both fresh and resumed Codex invocations', () => {
  const endpoint = 'unix:///tmp/munder-codex/a/app-server-control/app-server-control.sock';
  assert.deepEqual(
    withCodexRemoteArgs(['--model', 'gpt-5.6-sol', 'hello'], endpoint),
    ['--remote', endpoint, '--model', 'gpt-5.6-sol', 'hello']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['resume', 'session-id', '--model', 'gpt-5.6-sol'], endpoint),
    ['--remote', endpoint, 'resume', 'session-id', '--model', 'gpt-5.6-sol']
  );
  assert.deepEqual(
    withCodexRemoteArgs(['--remote', endpoint, 'resume'], endpoint),
    ['--remote', endpoint, 'resume']
  );
});
