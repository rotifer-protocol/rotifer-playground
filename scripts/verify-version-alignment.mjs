#!/usr/bin/env node

import {
  verifyRustVersionAlignment,
  verifyReadmeStatusFreshness,
} from "./lib/version-alignment.mjs";

const rust = verifyRustVersionAlignment();
// The README's Status line is the paragraph npm prints under the package title.
// It is checked here rather than in its own job so it inherits both gates this
// script already sits behind: CI's Lint & Type Check, and release.yml's
// Pre-release Validation — the second being the one that matters, since drift
// only becomes visible to the public at publish time.
const readme = verifyReadmeStatusFreshness();

const errors = [...rust.errors, ...readme.errors];

if (errors.length === 0) {
  console.log(`Version alignment OK (Rust workspace ${rust.workspaceVersion}, README Status current)`);
  process.exit(0);
}

// Report everything, not just the first failure: someone fixing a version skew
// should not have to run this three times to discover three problems.
console.error("Version alignment check failed:");
for (const error of errors) {
  console.error(`- ${error}`);
}
process.exit(1);
