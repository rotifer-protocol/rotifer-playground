import { defineConfig } from "vitest/config";

// Live checks against the real ClawHub and Rotifer Cloud, kept out of the PR
// gate (vitest.config.ts excludes tests/live/**) and run on a schedule:
// .github/workflows/live-checks.yml. `npm run test:live [-- <suite>]`.
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    globals: false,
    // Each wrap makes two calls of up to 30 s, with up to three attempts each.
    testTimeout: 180_000,
  },
});
