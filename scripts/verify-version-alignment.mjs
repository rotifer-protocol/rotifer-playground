#!/usr/bin/env node

import { verifyRustVersionAlignment } from "./lib/version-alignment.mjs";

const result = verifyRustVersionAlignment();

if (result.ok) {
  console.log(`Version alignment OK (Rust workspace ${result.workspaceVersion})`);
  process.exit(0);
}

console.error("Version alignment check failed:");
for (const error of result.errors) {
  console.error(`- ${error}`);
}
process.exit(1);
