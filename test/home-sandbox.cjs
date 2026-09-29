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
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // The check is the point. A sandbox that did not take is not a slow sandbox,
    // it is no sandbox, and the code under test will be handed the real home.
    if (path.resolve(os.homedir()) !== path.resolve(home)) {
      throw new Error(
        `home redirect did not take: os.homedir() is ${os.homedir()}, not ${home}. ` +
        'Refusing to run, because everything below would touch the real home.'
      );
    }
    return run(home);
  } finally {
    for (const k of ['HOME', 'USERPROFILE']) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { withHome };
