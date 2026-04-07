/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  reporters: ["html", "clear-text", "progress"],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
  },
  mutate: [
    "src/utils/content-hash.ts",
    "src/utils/gene-validator.ts",
    "src/commands/publish.ts",
    "src/commands/install.ts",
    "src/commands/login.ts",
  ],
  ignorePatterns: ["dist", "node_modules", "crates", "genes", "coverage"],
  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  timeoutMS: 30000,
  concurrency: 2,
};
