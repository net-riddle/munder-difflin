'use strict';
/**
 * 075: the endpoint is a `unix://` URL, so its path is POSIX on every host.
 *
 * The old value on Windows was `unix://\tmp\9ab0016d\...` — the scheme says
 * POSIX, the path says win32, and the two disagree inside one string. That is a
 * value no caller can detect by looking at it, which is why the fix belongs in
 * the value and not in a guard around it.
 *
 * Kelly's codex-remote.test.cjs is NOT modified (card boundary) and is the
 * reason the answer is "produce the right value" rather than "throw": her file
 * pins the `unix://` scheme on every platform, and a throw would break a test
 * that is right about the scheme.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  CODEX_REMOTE_SOCKET_MAX,
  CODEX_REMOTE_SOCKET_RELATIVE
} = loadTs('src/shared/codexRemote.ts');

const alias = () => codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');

test('the endpoint path is POSIX on every host, whatever path.join would have done', () => {
  const a = alias();
  const endpoint = codexRemoteEndpoint(a);
  assert.equal(endpoint, `unix://${a}/${CODEX_REMOTE_SOCKET_RELATIVE}`,
    'the endpoint must be the alias path verbatim, POSIX separators and all');
  assert.ok(endpoint.startsWith('unix:///tmp/'),
    `the /tmp root must survive as a POSIX literal: ${endpoint}`);
  assert.ok(!endpoint.includes('\\'),
    `a unix:// URL must not carry a backslash: ${endpoint}`);
});

test('a host-platform join is not what decides the separator', () => {
  // If the module used the host's join, this value would be a win32 path on
  // Windows and a POSIX path on macOS, so the SAME input would mean two
  // different sockets. The digest is the only thing that may differ.
  const a = codexRemoteEndpoint(codexRemoteAliasPath('/h/.codex', 'dev-1', '/tmp'));
  const b = codexRemoteEndpoint(codexRemoteAliasPath('/h/.codex', 'dev-1', '/tmp'));
  assert.equal(a, b, 'same inputs, same endpoint, on every host');
  assert.match(a, /^unix:\/\/\/tmp\/[0-9a-f]{8}\//);
});

test('the socket length budget is measured on a POSIX path too', () => {
  // sun_path is a POSIX limit. Measuring it on a win32-joined string measures a
  // path the daemon will never bind, so the check would be about the wrong
  // bytes.
  const long = codexRemoteAliasPath('/h/.codex', 'a',
    '/var/folders/v6/9f10q5d148z7bxdzhr22xl7r0000gn/T/munder-codex');
  assert.equal(codexRemoteSocketFits(long), false, 'an over-long POSIX root must still be rejected');
  assert.equal(codexRemoteSocketFits(codexRemoteAliasPath('/h/.codex', 'a')), true);
});

test('the endpoint stays inside sun_path with the default alias root', () => {
  const realHome = '/Users/vyapakgoyal/Documents/HarnessAgents/hive/agents/dev2-mrxb3l43/.codex';
  const socket = codexRemoteAliasPath(realHome, 'dev2-mrxb3l43') + '/' + CODEX_REMOTE_SOCKET_RELATIVE;
  assert.ok(socket.length < CODEX_REMOTE_SOCKET_MAX, `${socket.length} bytes`);
  assert.ok(socket.length < realHome.length + CODEX_REMOTE_SOCKET_RELATIVE.length + 1,
    'and still shorter than the home it replaces');
});

test('the alias is a real POSIX path, so it is the same on every host', () => {
  const a = codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-1', '/tmp');
  assert.ok(a.startsWith('/tmp/'), `the alias root is a POSIX literal and must not be rewritten: ${a}`);
  assert.ok(!a.includes('\\'), `no host separator: ${a}`);
  // And the digest is still per-agent, which is the whole point of the alias.
  assert.notEqual(a, codexRemoteAliasPath('/very/long/hive/agent/.codex', 'dev-2', '/tmp'));
});

test('the module never imports the host path join, so the platform cannot creep back in', () => {
  // The structural pin. A future edit that reaches for `join` again would
  // reintroduce the exact defect, and every behavioural test above would still
  // pass on the CI platform they run on.
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'shared', 'codexRemote.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /(?<!\.)\bjoin\s*\(/,
    'a bare join() is the host path join; use posix.join for a unix socket path');
  assert.match(code, /posix\.join\(/, 'and the POSIX one must actually be used');
});
