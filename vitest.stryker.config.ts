import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * The test configuration Stryker runs against.
 *
 * Two differences from the normal run, both forced by how Stryker executes:
 *
 * Three tests excluded — Stryker's vitest runner executes in worker threads,
 * where `process.chdir()` throws, and these three call it. One failing test in
 * the dry run aborts the whole pass before a single mutant is tried. Setting
 * `pool: "forks"` does not help: the runner overrides the pool.
 *
 * Excluding them costs no killing power here, which was checked rather than
 * assumed: they exercise `commands/run`, `commands/network` and `utils/config`,
 * and none of the three mutated files appears in any of them. They still run
 * in `npm test`, which is where they count.
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
      ],
      coverage: { enabled: false },
    },
  }),
);
