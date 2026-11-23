/**
 * Per test file (vitest setupFiles, T-237).
 *
 * 1. HOME is a fresh temporary directory before the test file and the modules
 *    it imports are loaded, so a module that fixes `~/.rotifer` at import
 *    time gets the temporary one. Tests that stub HOME themselves still can;
 *    `vi.unstubAllEnvs()` returns to this one.
 * 2. After the file, the real `~/.rotifer` and `~/.config/rotifer` are
 *    compared with how they were before it (names, sizes, mtimes; no file is
 *    opened). A change fails this file and names what changed. Files run in
 *    parallel, so a write may fail the files running beside the one that made
 *    it too; the run is red either way.
 *
 * `real-home-guard.global.ts` covers the whole run, including what happens
 * between files.
 */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes, realHome, snapshot, watchedDirs } from "./real-home.js";

const real = realHome();
const watched = watchedDirs(real);
const before = snapshot(watched);

const home = mkdtempSync(join(process.env.ROTIFER_TEST_HOME_ROOT || tmpdir(), "home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  const changed = changes(before, snapshot(watched), real);
  if (changed.length > 0) {
    throw new Error(
      `This test file ran while the real home's Rotifer state changed (${real}):\n  ${changed.join("\n  ")}\n` +
        "A module probably read HOME before the temporary HOME was set, or a test used the real home on purpose. " +
        "If another program wrote these files at that time instead, check them and run again.",
    );
  }
});
