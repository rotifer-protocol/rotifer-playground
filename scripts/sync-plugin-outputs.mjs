import { REPO_ROOT, syncOutputs } from "./lib/plugin-source.mjs";

syncOutputs(REPO_ROOT);
console.log("Synced plugin outputs from plugin-source/");
