import * as pty from 'node-pty';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveCommand, userShellPath } from './shellEnv';
import { expandTilde } from './fs';
import { projectDir } from './transcript';
import { ensureKilled } from './procKill';

/**
 * Shared helper: run a HIDDEN interactive claude session (ephemeral PTY) and
 * return the assistant's final text response.
 *
 * "Hidden" means: not added to the PtyManager, not emitted to the renderer,
 * not visible in the agent list or OfficeFloor scene. Each call spawns its own
 * session and kills it after capture — no /clear needed, no context bleed.
 *
 * Uses an interactive PTY (not `claude -p`) so calls draw from the user's
 * normal interactive plan quota, not the Agent SDK credit that moves to a
 * separate claim-required pool from 2026-06-15.
 *
 * Session lifecycle:
 *   spawn → boot-quiet detect → bracketed-paste prompt + \r → idle-settle →
 *   transcript JSONL extract (last assistant text block) → kill
 */

/** ms of PTY silence that signals the TUI is ready for input (boot complete). */
const BOOT_QUIET_MS = 1500;

export interface HiddenClaudeOptions {
  /** Model to use (e.g. 'claude-haiku-4-5'). */
  model: string;
  /** Working directory for the claude session. */
  cwd: string;
  /** Base claude command/binary. Defaults to 'claude'. */
  command?: string;
  /** Tools the session is forbidden to use. Defaults to ['Edit','Write','NotebookEdit']. */
  disallowedTools?: string[];
  /** Directories added via --add-dir (for context gathering). */
  addDirs?: string[];
  /** Hard cap ms before forcing prompt send regardless of boot activity. Default 7000. */
  bootCapMs?: number;
  /** ms of PTY silence after the prompt that signals response is complete. Default 3500. */
  idleMs?: number;
  /** Total timeout ms. Default 180000. */
  timeoutMs?: number;
  /** Extra env merged over the resolved shell env (e.g. the shared MemPalace). */
  env?: Record<string, string>;
}

/** Why a hidden session produced no usable answer.
 *
 *  These used to be four separate `return null`s inside
 *  extractLastAssistantText, all of which surfaced as the single string
 *  'no assistant response found in transcript'. That collapsed a missing
 *  project directory and a filesystem exception into the same line, which is
 *  how a 35-run failure stayed undiagnosable: the reader could not tell "we
 *  never wrote a transcript" from "we could not read one". Each case now
 *  names itself. */
export type HiddenClaudeFailure =
  /** ~/.claude/projects/<key for cwd> does not exist — no session was ever recorded here. */
  | 'project-dir-missing'
  /** The directory exists but no .jsonl was written at or after the spawn. */
  | 'no-fresh-transcript'
  /** A transcript was found, but it holds no assistant text block. */
  | 'no-assistant-text'
  /** The transcript could not be read (permissions, race, malformed fs). */
  | 'transcript-unreadable';

export interface HiddenClaudeResult {
  ok: boolean;
  /** The assistant's final text response (stripped of any TUI framing). */
  text?: string;
  error?: string;
  /** Which of the failure cases above this was. Absent on success. */
  reason?: HiddenClaudeFailure;
  /** The concrete path involved: the project directory, and the transcript file
   *  when one existed. Its basename is the Claude session id. */
  detail?: string;
}

/**
 * Extract the last assistant text block from the transcript JSONL written
 * at or after `spawnedAt`. Reuses projectDir() from transcript.ts.
 *
 * Returns which of the four failure cases applied rather than a bare null, so
 * the caller can log something that actually distinguishes them.
 *
 * Exported for tests: the four branches are the whole point of this change and
 * they are unreachable without spawning a real `claude`.
 */
  /**
   * Whether a hidden run's answer will be readable back at all.
   *
   * The directory either exists or it does not, so this is decidable in
   * microseconds — WITHOUT spawning the process whose answer depends on it.
   *
   * Measured 2026-09-29: the hidden `claude` does not create a transcript for
   * every cwd this floor uses. `condense` was therefore paying a real
   * `claude -p` Haiku run, per agent, per tick, purely to be told the answer
   * could not be read — 101 aborts, 0 successes, ~3 more every ten minutes.
   *
   * Anything about to spend minutes on an answer should ask this first. It is
   * the same check `extractLastAssistantText` opens with, named and exported so
   * the two cannot drift apart. */
  export function transcriptPrecheck(cwd: string):
    { ok: true; dir: string } | { ok: false; reason: HiddenClaudeFailure; detail: string } {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return { ok: false, reason: 'project-dir-missing', detail: dir };
    return { ok: true, dir };
  }

  export function extractLastAssistantText(
    cwd: string, spawnedAt: number
  ): { ok: true; text: string } | { ok: false; reason: HiddenClaudeFailure; detail: string } {
    // One definition of the precondition, not two that can drift.
    const pre = transcriptPrecheck(cwd);
    if (!pre.ok) return pre;
    const dir = pre.dir;

  const candidates: { f: string; mtime: number }[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const mtime = statSync(path.join(dir, f)).mtimeMs;
        // 5 s slack: include files that already existed at spawn but were
        // updated by this session. Sort by mtime and take the newest.
        if (mtime >= spawnedAt - 5000) candidates.push({ f, mtime });
      } catch { /* file removed between readdir and stat — skip */ }
    }
  } catch (e) {
    return { ok: false, reason: 'transcript-unreadable', detail: `${dir} (${e})` };
  }
  if (!candidates.length) {
    return { ok: false, reason: 'no-fresh-transcript', detail: dir };
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  const newest = candidates[0];
  // The basename is the Claude session id, so quoting the file makes the log
  // line answer "which session?" as well as "which directory?".
  const newestPath = path.join(dir, newest.f);

  let lines: string[];
  try {
    lines = readFileSync(newestPath, 'utf8').split('\n');
  } catch (e) {
    return { ok: false, reason: 'transcript-unreadable', detail: `${newestPath} (${e})` };
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let rec: { type?: unknown; message?: { content?: unknown[] } };
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: unknown; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return { ok: true, text: block.text.trim() };
      }
    }
  }
  return { ok: false, reason: 'no-assistant-text', detail: newestPath };
}

export function runHiddenClaude(prompt: string, opts: HiddenClaudeOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    // Defense-in-depth: `~` is shell syntax, not a path Node understands.
    const cwd = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    if (!cwd || !existsSync(cwd)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    opts = { ...opts, cwd };

    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
    const addDirs = (opts.addDirs ?? []).filter((d) => d && existsSync(d));

    const args: string[] = [
      '--model', opts.model,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', ...disallowed,
    ];
    for (const d of addDirs) { args.push('--add-dir', d); }

    const bootCapMs = opts.bootCapMs ?? 7000;
    const idleMs = opts.idleMs ?? 3500;
    const timeoutMs = opts.timeoutMs ?? 180_000;

    const spawnedAt = Date.now();
    // Windows: node-pty's CreateProcess can't exec the npm `.cmd`/extensionless
    // `claude` shim directly (ERROR_BAD_EXE_FORMAT, error 193) — route non-.exe
    // targets through cmd.exe. A real claude.exe (WinGet) launches directly. (#22)
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? (process.env.ComSpec || 'cmd.exe') : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;
    let ptyProc: pty.IPty;
    try {
      ptyProc = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd: opts.cwd,
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...(opts.env ?? {}),
        } as Record<string, string>,
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let settled = false;
    let promptSent = false;
    let bootTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let bootMaxTimer: NodeJS.Timeout;
    let globalTimer: NodeJS.Timeout;

    // Hidden sessions are ephemeral CHECKS — nothing they spawn (MCP servers,
    // helpers) may outlive them. Kill politely, then sweep the process group so
    // every check releases its PIDs even if `claude` shrugs off the SIGHUP.
    const kill = () => {
      const pid = ptyProc.pid;
      try { ptyProc.kill(); } catch { /* noop */ }
      ensureKilled(pid);
    };

    const finish = (r: HiddenClaudeResult) => {
      if (settled) return;
      settled = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      clearTimeout(bootMaxTimer);
      clearTimeout(globalTimer);
      kill();
      resolve(r);
    };

    const captureAndFinish = () => {
      const found = extractLastAssistantText(opts.cwd, spawnedAt);
      if (found.ok) {
        finish({ ok: true, text: found.text });
        return;
      }
      // Name the case and the path. Before this, all four cases produced
      // 'no assistant response found in transcript' and a reader had no way to
      // tell a missing directory from an unreadable file.
      finish({
        ok: false,
        reason: found.reason,
        detail: found.detail,
        error: `no assistant response found in transcript (${found.reason}): ${found.detail}`,
      });
    };

    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      // Bracketed paste + enter — same mechanism as submitToPty in useHive.ts.
      ptyProc.write(`\x1b[200~${prompt}\x1b[201~`);
      setTimeout(() => { if (!settled) ptyProc.write('\r'); }, 140);
    };

    bootMaxTimer = setTimeout(sendPrompt, bootCapMs);
    globalTimer = setTimeout(
      () => finish({ ok: false, error: 'hidden session timed out' }),
      timeoutMs,
    );

    ptyProc.onData(() => {
      if (!promptSent) {
        // Boot phase: reset quiet timer; send prompt once output goes quiet.
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = setTimeout(sendPrompt, BOOT_QUIET_MS);
      } else {
        // Response phase: reset idle timer; capture when output settles.
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(captureAndFinish, idleMs);
      }
    });

    // Session exited cleanly before idle — try to capture the transcript anyway.
    ptyProc.onExit(() => { if (!settled) captureAndFinish(); });
  });
}
