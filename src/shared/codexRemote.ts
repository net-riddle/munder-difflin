import { createHash } from 'node:crypto';
// `posix`, not the default: every path in this module names a UNIX DOMAIN
// SOCKET, and a Unix socket path is POSIX on every host. The alias root below is
// already a POSIX literal (`/tmp/mdc`), so using the host's `join` did not
// merely add a platform opinion — it rewrote the constant the module was written
// around. On Windows `join('/tmp/mdc', d)` is `\tmp\mdc\d`, and the endpoint came
// out as `unix://\tmp\mdc\d/...`: a `unix://` URL whose path is not a path.
//
// The old shape was protected by the CALLER (src/main/index.ts:163 returns false
// on win32 before anything here is computed), which is a protection in a
// different file from the defect. That holds exactly as long as every caller
// remembers the gate. Making the value correct removes the dependency instead:
// there is no wrong value left to be protected from.
//
// Fixing the separator also removes the need to refuse. A thrown error would
// have been defensible — Windows has no Unix sockets, so `unix://` means nothing
// there — but it would leave the real question open ("and what SHOULD it
// return?") while breaking a test that pins the scheme on every platform.
// `posix.join` answers the question instead of dodging it: a `unix://` URL has a
// POSIX path by definition (RFC 8089), whatever the machine asking.
import { posix } from 'node:path';

export const CODEX_REMOTE_SOCKET_RELATIVE =
  'app-server-control/app-server-control.sock';

/** macOS caps a Unix socket path at 104 bytes (`sun_path`), and Codex builds its
 *  control socket as `$CODEX_HOME/app-server-control/app-server-control.sock` —
 *  42 bytes of suffix. So the alias home itself must fit in ~61 bytes.
 *
 *  `$TMPDIR` cannot host it: macOS spells it
 *  `/var/folders/xx/<30-char-hash>/T/` (49 bytes) and the alias came out at 121
 *  — LONGER than the 118-byte real home it was introduced to shorten, so every
 *  daemon start failed with `path must be shorter than SUN_LEN`. Root the alias
 *  at a fixed short prefix instead and keep the digest to 8 hex chars: the whole
 *  socket path then lands at 60 bytes with room to spare. */
export const CODEX_REMOTE_ALIAS_ROOT = '/tmp/mdc';

/** Longest socket path the platform will accept, minus a small safety margin. */
export const CODEX_REMOTE_SOCKET_MAX = 104;

/** Keep the CODEX_HOME spelling short enough for macOS's Unix-socket limit.
 *  `tempRoot` defaults to the short fixed root; callers may override it (tests). */
export function codexRemoteAliasPath(
  realHome: string,
  agentId: string,
  tempRoot: string = CODEX_REMOTE_ALIAS_ROOT
): string {
  const digest = createHash('sha256')
    .update(`${realHome}\0${agentId}`)
    .digest('hex')
    .slice(0, 8);
  return posix.join(tempRoot, digest);
}

/** Whether a candidate home yields a control socket the platform can bind. */
export function codexRemoteSocketFits(shortHome: string): boolean {
  return posix.join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE).length < CODEX_REMOTE_SOCKET_MAX;
}

export function codexRemoteEndpoint(shortHome: string): string {
  return `unix://${posix.join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE)}`;
}

/** Global options must precede `resume`, so prepend the endpoint in all cases. */
export function withCodexRemoteArgs(args: string[], endpoint: string): string[] {
  if (args.includes('--remote')) return args;
  return ['--remote', endpoint, ...args];
}
