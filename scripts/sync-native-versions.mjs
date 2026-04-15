#!/usr/bin/env node

/**
 * Sync platform package versions with root package.json.
 * Usage: node scripts/sync-native-versions.mjs [version]
 * If version is omitted, reads from root package.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.argv[2] || rootPkg.version;

const platforms = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "win32-x64-msvc"];

for (const platform of platforms) {
  const pkgPath = join(root, "npm", platform, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  npm/${platform}/package.json → ${version}`);
}

const optDeps = rootPkg.optionalDependencies || {};
let changed = false;
for (const platform of platforms) {
  const depName = `@rotifer/playground-${platform}`;
  if (optDeps[depName] && optDeps[depName] !== version) {
    optDeps[depName] = version;
    changed = true;
  }
}
if (changed) {
  rootPkg.optionalDependencies = optDeps;
  writeFileSync(join(root, "package.json"), JSON.stringify(rootPkg, null, 2) + "\n");
  console.log(`  package.json optionalDependencies → ${version}`);
}

console.log(`\n✅ All native packages synced to v${version}`);
