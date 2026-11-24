import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/unit/protobuf-schema.test.ts",
      "tests/unit/development-genome-eval.test.ts",
      "tests/unit/rls-verification.test.ts",
      "tests/unit/scan-top50.test.ts",
      // Live third-party checks: run on a schedule (vitest.live.config.ts).
      "tests/live/**",
    ],
    globals: false,
    // Keep every test out of the developer's real ~/.rotifer (T-237): a
    // temporary HOME per test file, set before it is imported, and a check
    // that fails the run if the real one changed. See tests/setup/.
    globalSetup: ["tests/setup/real-home-guard.global.ts"],
    setupFiles: ["tests/setup/temp-home.ts"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "src/cloud/**/*.ts",
        "src/memory/**/*.ts",
        "src/publish/**/*.ts",
        "src/runtime/**/*.ts",
        "src/scanner/**/*.ts",
        "src/utils/**/*.ts",
      ],
      exclude: ["src/**/*.d.ts", "src/**/index.ts"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 55,
        statements: 60,
        // AgentMemory (v0.9.4) on its own as well: inside the aggregate a
        // regression there would be diluted by everything else.
        "src/memory/**/*.ts": {
          lines: 60,
          functions: 60,
          branches: 55,
          statements: 60,
        },
      },
    },
  },
});
