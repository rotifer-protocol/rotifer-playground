import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/protobuf-schema.test.ts",
      "tests/unit/development-genome-eval.test.ts",
      "tests/unit/rls-verification.test.ts",
      "tests/unit/scan-top50.test.ts",
    ],
    globals: false,
    // Keep every test out of the developer's real ~/.rotifer (T-237): a
    // temporary HOME per test file, set before it is imported, and a check
    // that fails the run if the real one changed. See tests/setup/.
    globalSetup: ["tests/setup/real-home-guard.global.ts"],
    setupFiles: ["tests/setup/temp-home.ts"],
    testTimeout: 10000,
  },
});
