import { REPO_ROOT, diffOutputs, formatDiffs } from "./lib/plugin-source.mjs";

const diffs = diffOutputs(REPO_ROOT);

if (diffs.length > 0) {
  console.error("Plugin outputs drift from plugin-source/:");
  for (const line of formatDiffs(diffs, REPO_ROOT)) {
    console.error(line);
  }
  process.exit(1);
}

console.log("Plugin outputs are in sync.");
