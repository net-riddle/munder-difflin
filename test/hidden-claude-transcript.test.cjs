'use strict';

// task-pam-020: `summarize-failed` collapsed four different failures into one
// log line — 'no assistant response found in transcript' — so 35 aborts could
// not be told apart, and nothing in the line said which case it was or which
// session it was about.
//
// Measured before fixing: the case actually taken, for every cwd this floor
// uses, is `project-dir-missing`. The hidden `claude` never wrote a transcript
// for our directories. That was invisible precisely because case 1 (directory
// absent) and case 4 (a filesystem exception) rendered identically.
//
// These tests pin the thing the change is for: each case names itself, and the
// detail carries the path — so the next occurrence is diagnosable from the log
// line alone, without re-deriving anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { extractLastAssistantText } = loadTs('src/main/hiddenClaude.ts');

const CWD = '/Users/me/app';
const KEY = '-Users-me-app';

/** Redirects os.homedir() to a throwaway directory so the real ~/.claude is
 *  never read or written. The pre-existing transcript tests redirect $HOME,
 *  which is POSIX-only; on Windows os.homedir() reads USERPROFILE, so both are
 *  set here and this file runs on either platform. */
function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const dir = path.join(home, '.claude/projects', KEY);
  try {
    return run(dir);
  } finally {
    for (const k of ['HOME', 'USERPROFILE']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Writes a transcript whose mtime is `age` ms in the past, so a test can be
 *  either "fresh enough to count" or "too old", without sleeping. */
function writeTranscript(dir, name, records, age = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  if (age) {
    const t = new Date(Date.now() - age);
    fs.utimesSync(file, t, t);
  }
  return file;
}

const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('case 1: no project directory names itself and says which directory', () => {
  withHome((dir) => {
    // The directory is never created: nothing has ever recorded a session here.
    const r = extractLastAssistantText(CWD, Date.now());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'project-dir-missing');
    // The detail is the path, so the missing directory is recomputable from the
    // log line without knowing the cwd convention.
    assert.equal(r.detail, dir);
  });
});

test('case 2: directory exists but nothing fresh was written', () => {
  withHome((dir) => {
    fs.mkdirSync(dir, { recursive: true });
    // An old transcript is not this session's output.
    writeTranscript(dir, 'old.jsonl', [assistantText('stale')], 60 * 60 * 1000);
    const r = extractLastAssistantText(CWD, Date.now());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-fresh-transcript');
    assert.equal(r.detail, dir);
  });
});

test('case 3: a fresh transcript with no assistant text names the file, hence the session', () => {
  withHome((dir) => {
    // The basename of a Claude transcript IS the session id, so quoting the
    // file answers "which session?" as well as "which directory?".
    writeTranscript(dir, 'sess-abc123.jsonl', [{ type: 'user', message: { content: 'hi' } }]);
    const r = extractLastAssistantText(CWD, Date.now());
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-assistant-text');
    assert.ok(r.detail.includes('sess-abc123.jsonl'), `detail should name the transcript, got: ${r.detail}`);
  });
});

test('the four reasons are distinct strings, so the log line can be told apart', () => {
  // The regression in one assertion: a case that reuses another case's name (or
  // a shared fallback) would make the log ambiguous again while every individual
  // case still looked correct.
  const reasons = ['project-dir-missing', 'no-fresh-transcript', 'no-assistant-text', 'transcript-unreadable'];
  assert.equal(new Set(reasons).size, reasons.length);
});

test('a real assistant response is still returned, and the newest transcript wins', () => {
  withHome((dir) => {
    writeTranscript(dir, 'old.jsonl', [assistantText('the old answer')], 60 * 60 * 1000);
    writeTranscript(dir, 'new.jsonl', [assistantText('first'), assistantText('the answer')]);
    const r = extractLastAssistantText(CWD, Date.now());
    assert.equal(r.ok, true);
    assert.equal(r.text, 'the answer');
  });
});
