import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "src/cloud/**/*.ts",
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
      },
    },
  },
});
