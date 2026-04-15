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
    testTimeout: 10000,
  },
});
