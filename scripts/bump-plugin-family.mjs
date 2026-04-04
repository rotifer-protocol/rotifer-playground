import { REPO_ROOT, syncOutputs, updateFamilyVersion } from "./lib/plugin-source.mjs";

const [, , familyName, version] = process.argv;

if (!familyName || !version) {
  console.error("Usage: node scripts/bump-plugin-family.mjs <root|vscode> <version>");
  process.exit(1);
}

try {
  updateFamilyVersion(REPO_ROOT, familyName, version);
  syncOutputs(REPO_ROOT);
  console.log(`Updated ${familyName} family to ${version} and regenerated outputs.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
