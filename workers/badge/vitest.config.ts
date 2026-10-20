import { defineConfig } from "vitest/config";

// Own config so this package's tests run standalone from workers/badge/.
// Without it vitest walks up to the repo-root vitest.config.ts, which needs
// the root node_modules installed.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
