// Run a scenario against rotifer-napi's PlaygroundBinding (the local store,
// SQLite in rotifer-core) and print normalized results as JSON.
//
//   ROTIFER_NAPI=/path/to/rotifer_napi.node node run-napi.mjs [scenario.json] > napi.json
//
// ROTIFER_NAPI is a release build of crates/rotifer-napi (cargo build
// --release -p rotifer-napi, the .dylib/.so copied to a .node name). A
// scenario with "advance" steps needs a build with the test-only clock
// (memoryTestAdvanceClock), which release builds do not have. A fresh
// temporary project directory is used and removed afterwards.
//
// Each result also lists the entry ids purged for expiry during that step,
// read from the new "expired" lines in the project's .rotifer/audit.jsonl.

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, materialize, normalize, normalizeExpired, scenarioName, sleep, STEP_PAUSE_MS } from "./common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(readFileSync(join(here, scenarioName(process.argv[2])), "utf8"));
const bindingPath = process.env.ROTIFER_NAPI;
if (!bindingPath) {
  console.error("set ROTIFER_NAPI to the built rotifer-napi .node file");
  process.exit(2);
}
const { PlaygroundBinding } = createRequire(import.meta.url)(bindingPath);
if (typeof PlaygroundBinding?.prototype?.memoryWrite !== "function") {
  console.error("this binding has no memory methods (needs the v0.9.4 core)");
  process.exit(2);
}
const needsClock = scenario.steps.some((s) => s.op === "advance");
if (needsClock && typeof PlaygroundBinding.prototype.memoryTestAdvanceClock !== "function") {
  console.error("this scenario moves the clock; build rotifer-napi with its test-only clock");
  process.exit(2);
}

const project = mkdtempSync(join(tmpdir(), "rotifer-parity-"));
const auditPath = join(project, ".rotifer", "audit.jsonl");
let auditSeen = 0;
function newlyExpired(agent) {
  if (!existsSync(auditPath)) return [];
  const lines = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
  const fresh = lines.slice(auditSeen);
  auditSeen = lines.length;
  return fresh
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === "agent_memory" && e.action === "expired" && e.agentId === agent)
    .map((e) => e.entryId);
}

const results = [];
try {
  const b = new PlaygroundBinding(project);
  const agent = scenario.agentId;
  for (const step of scenario.steps) {
    let result;
    try {
      let value = null;
      if (step.op === "create") {
        value = b.memoryCreate(agent, step.quota);
        // The Cloud stores no DataPolicy, so an entry without its own policy
        // never expires there; set the local agent the same way.
        if ("dataPolicyRetentionDays" in scenario) b.memorySetDataPolicyRetention(agent, scenario.dataPolicyRetentionDays);
      } else if (step.op === "advance") {
        b.memoryTestAdvanceClock(step.seconds * 1000);
      } else if (step.op === "usage") {
        value = b.memoryGet(agent);
      } else {
        const g = scenario.genes[step.as];
        const req = JSON.stringify(materialize(step.request, scenario));
        const fn = { write: "memoryWrite", read: "memoryRead", query: "memoryQuery", delete: "memoryDelete" }[step.op];
        value = b[fn](agent, g.geneId, g.domain, req);
      }
      result = step.op === "advance" ? { ok: null } : { ok: normalize(step.op, value) };
    } catch (e) {
      result = { error: errorCode(e?.message ?? e) };
    }
    result.expired = normalizeExpired(newlyExpired(agent));
    results.push({ id: step.id, result });
    await sleep(STEP_PAUSE_MS);
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ binding: "napi", results }, null, 1) + "\n");
