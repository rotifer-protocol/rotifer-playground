import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The test configuration Stryker runs against.
 *
 * Two differences from the normal run, both forced by how Stryker executes:
 *
 * Three unit tests excluded — Stryker's vitest runner executes in worker
 * threads, where `process.chdir()` throws, and these three call it. One failing
 * test in the dry run aborts the whole pass before a single mutant is tried.
 * Setting `pool: "forks"` does not help: the runner overrides the pool.
 *
 * Excluding them costs no killing power here, which was checked rather than
 * assumed: they exercise `commands/run`, `commands/network` and `utils/config`,
 * and none of the three mutated files appears in any of them. They still run
 * in `npm test`, which is where they count.
 *
 * The black-box suites excluded for the same reason, on the same evidence.
 * They drive the CLI by spawning `node dist/index.js`, so the code under test
 * runs in a child process that Stryker never instruments — a mutant cannot die
 * there no matter how thorough the assertion. What they can do is abort the
 * dry run: some of them assert on wall-clock duration, and under Stryker's two
 * concurrent runners those deadlines slip. That failure reads as a mutation
 * score problem, which is the wrong place to look.
 *
 * Checked, not assumed: of the 146 test files, 48 spawn the CLI and 15 import
 * `cloud/auth`, `cloud/client` or `pre-publish-check`. The two sets do not
 * overlap, and all 15 live in `tests/unit`. `tests/e2e`, `tests/edge`,
 * `tests/resilience` and `tests/security` contain no file that imports a
 * mutated module, so they go by directory; `tests/unit/publish-changelog`
 * is the one spawning file outside them.
 *
 * Coverage off — Stryker instruments the source itself, and running v8
 * coverage on top of that instrumentation costs time on every one of the
 * hundreds of test runs a mutation pass performs, for a number nobody reads.
 * The thresholds are enforced by `npm run test:coverage` (plain `npm test`
 * never loads them — vitest only applies thresholds when coverage runs).
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        ...(base.test?.exclude ?? []),
        "tests/unit/run-command.test.ts",
        "tests/unit/network-p2p.test.ts",
        "tests/unit/config.test.ts",
        "tests/e2e/**",
        "tests/edge/**",
        "tests/resilience/**",
        "tests/security/**",
        "tests/unit/publish-changelog.test.ts",
      ],
      coverage: { enabled: false },
    },
  }),
);
