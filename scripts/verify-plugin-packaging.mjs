import { REPO_ROOT, verifyPluginPackaging } from "./lib/plugin-source.mjs";

const result = verifyPluginPackaging(REPO_ROOT);

if (!result.ok) {
  console.error("Plugin packaging verification failed:");
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Plugin packaging verification passed.");
