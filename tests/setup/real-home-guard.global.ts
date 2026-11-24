/**
 * Global guard (vitest globalSetup, T-237): the run fails if anything under
 * the real `~/.rotifer` or `~/.config/rotifer` was added, removed or changed
 * while the tests ran.
 *
 * Why: a module that reads HOME when it is imported (network.ts and seven
 * others) keeps the real home even if a test stubs HOME afterwards, so a test
 * wrote the developer's real network.json, and a mutation run deleted a file
 * there. `temp-home.ts` points HOME at a temporary directory before each test
 * file is imported; this guard is the check that nothing got through anyway.
 *
 * Each test file is also checked on its own (`temp-home.ts`), which is what
 * fails a file; this check covers the whole run, between files as well.
 *
 * HOME is also set here, before the test workers start, so every worker and
 * every process a test spawns without its own HOME inherits a temporary one.
 *
 * Only names, sizes and mtimes are compared; no file is opened. Another
 * program writing the real `~/.rotifer` during the run (a running node, a
 * `rotifer login` in another terminal) also trips it: the message names the
 * files, so check them before re-running.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes, realHome, snapshot, watchedDirs } from "./real-home.js";

export default function setup(): () => void {
  const home = realHome();
  const dirs = watchedDirs(home);
  const before = snapshot(dirs);

  const tempHome = mkdtempSync(join(tmpdir(), "rotifer-test-home-"));
  process.env.ROTIFER_TEST_REAL_HOME = home;
  process.env.ROTIFER_TEST_HOME_ROOT = tempHome;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  return () => {
    rmSync(tempHome, { recursive: true, force: true });
    const changed = changes(before, snapshot(dirs), home);
    if (changed.length > 0) {
      // vitest reports an error thrown here but keeps the exit code, so set it too.
      process.exitCode = 1;
      throw new Error(
        `Tests changed the real home's Rotifer state (${home}):\n  ${changed.join("\n  ")}\n` +
          "A module probably read HOME before the test's temporary HOME was set. " +
          "If another program wrote these files during the run instead, check them and run again.",
      );
    }
  };
}
