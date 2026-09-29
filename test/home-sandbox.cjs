'use strict';

/**
 * A throwaway home for a test, on every platform.
 *
 * WHY THIS EXISTS. A test that redirects `$HOME` and then calls `os.homedir()` is
 * testing against whatever the machine really has. Measured here, on Windows:
 *
 *   process.env.HOME = <temp>   ->  os.homedir() === 'C:\Users\danil'   (unchanged)
 *   + USERPROFILE = <temp>      ->  os.homedir() === <temp>              (redirected)
 *
 * POSIX reads `$HOME`; Windows reads `USERPROFILE`. So a suite that sets only
 * `$HOME` looks isolated, is not, and the failure it produces is the worst kind:
 * the test is GREEN and it was answering questions about the developer's real
 * `~/.claude`. In `transcript-project-dir.test.cjs` that meant `projectDir()`
 * probed the actual projects directory of the person running it, so each verdict
 * depended on what happened to be in their home — four tests that could not be
 * trusted on any machine but this one, and did not even say so.
 *
 * Two knobs, and a refusal. `os.homedir()` is checked BEFORE the test body runs,
 * and a redirect that did not take throws instead of proceeding — because the
 * whole value of a sandbox is that when it fails you stop rather than quietly
 * write into someone's home. `hive-hook-node.test.cjs` already does this inline;
 * this is the same guard, named once, so the next test uses it instead of
 * re-deriving which knob matters on which platform.
 *
 * WHY IT IS NOT `async`. Every caller that existed when this was written was
 * synchronous, and a plain `try/finally` around `return run(home)` restores the
 * environment and deletes the temporary directory the moment `run` RETURNS — not
 * when it SETTLES. Measured here, with a body that awaits:
 *
 *   sync phase    os.homedir() === SANDBOX
 *   after await   os.homedir() === REAL   (C:\Users\danil)
 *   temp home still on disk: false
 *
 * So an async test gets the real home back halfway through, with its own
 * directory already removed underneath it. That is the worst outcome available
 * and it is silent: the test believes it is sandboxed, and it is not. So the
 * two cases are told apart by what `run` returned — a thenable means the work is
 * still in flight, and restoring before it finishes is the bug. The synchronous
 * path stays fully synchronous, so the callers that predate this keep restoring
 * before their own `test()` body returns.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Run `run(home)` with `os.homedir()` pointed at a fresh temporary directory.
 *
 * @param {(home: string) => any} run
 * @param {{ prefix?: string }} [opts]
 */
function withHome(run, { prefix = 'md-home-' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const restore = () => {
    for (const k of ['HOME', 'USERPROFILE']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  };

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // The check is the point. A sandbox that did not take is not a slow sandbox,
  // it is no sandbox, and the code under test will be handed the real home.
  if (path.resolve(os.homedir()) !== path.resolve(home)) {
    const where = os.homedir();
    restore();
    throw new Error(
      `home redirect did not take: os.homedir() is ${where}, not ${home}. ` +
      'Refusing to run, because everything below would touch the real home.'
    );
  }

  let out;
  try {
    out = run(home);
  } catch (err) {
    restore();
    throw err;
  }

  // A thenable means the work is still in flight: restoring now would hand the
  // test the real home and delete its own directory mid-run. See the header.
  if (out && typeof out.then === 'function') {
    return out.then(
      (value) => { restore(); return value; },
      (err) => { restore(); throw err; }
    );
  }
  restore();
  return out;
}

module.exports = { withHome };
