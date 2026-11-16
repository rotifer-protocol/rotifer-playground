/**
 * `rotifer agent run` holds a granted credential to the host it was granted
 * for (#508), on each way it runs sandboxed genes: one gene at a time
 * (Single / Seq), the TryPool executor, and the Rust algebra executor (Par).
 *
 * The genes are external (installed from the Cloud) and Hybrid, and declare
 * one credential for GRANTED_HOST and a second dependency on OTHER_HOST; both
 * hosts are in their network allow-list, so only the grant keeps the
 * credential from OTHER_HOST. The hosts are `.invalid` (RFC 2606, never
 * resolve): a request that was let through ends as a network failure (-5, or
 * -4 if the resolver is slow); one refused by the limit ends as -2 before any
 * network call.
 *
 * Needs `npm run build` and the native addon built from this checkout. An
 * addon older than #508 ignores the limit, and these fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryLoadBinding } from "../../src/utils/binding.js";
import { bearerGene } from "../helpers/fetch-gene-wasm.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GRANTED_HOST = "rotifer-permission-test.invalid";
const OTHER_HOST = "rotifer-permission-other.invalid";
const ENV_NAME = "T508_AGENT_KEY";
const VALUE = "t508-agent-placeholder-value";
const GRANT = `--allow-credentials=${ENV_NAME}@${GRANTED_HOST}`;
const TIMEOUT = 60_000;
const REFUSED = /error code: -2\b/;
const LET_THROUGH = /error code: -(5|4)\b/;

let root = "";

const phenotype = {
  domain: "test.credentials",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  version: "0.1.0",
  fidelity: "Hybrid",
  externalDependencies: [
    { apiType: "rest", semanticTag: "credential-test", domains: [GRANTED_HOST], credentials: [ENV_NAME] },
    { apiType: "rest", semanticTag: "other-dependency", domains: [OTHER_HOST] },
  ],
  network: { allowedDomains: [GRANTED_HOST, OTHER_HOST], maxTimeoutMs: 5000 },
};

/** An external gene that sends the credential to `target`. */
function addGene(name: string, target: string): void {
  const dir = join(root, "genes", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify(phenotype));
  writeFileSync(join(dir, "gene.ir.wasm"), bearerGene(ENV_NAME, target));
  writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ installed_at: "2026-01-01T00:00:00Z" }));
}

function addAgent(name: string, genome: string[], composition: string): void {
  const dir = join(root, ".rotifer", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ id: name, name, genome, composition: { type: composition }, state: "Active", createdAt: "2026-01-01T00:00:00Z" }),
  );
}

function agentRun(agent: string): Promise<{ output: string; code: number }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: join(root, ".home"),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ROTIFER_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      ROTIFER_NO_UPDATE_CHECK: "1",
      ROTIFER_CLOUD_ENDPOINT: "https://127.0.0.1:9",
      [ENV_NAME]: VALUE,
    };
    execFile("node", [CLI, "agent", "run", agent, "--input", "{}", GRANT], { cwd: root, timeout: TIMEOUT, env }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ output: `${stdout}${stderr}`, code });
    });
  });
}

/** What a gene's runs wrote to its run log under the test's HOME. */
function runLog(gene: string): string {
  const path = join(root, ".home", ".rotifer", "run-logs", `${gene}.jsonl`);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

beforeAll(() => {
  expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
  root = mkdtempSync(join(tmpdir(), "rotifer-agent-credential-host-"));
  mkdirSync(join(root, ".home"), { recursive: true });
  writeFileSync(join(root, "rotifer.json"), JSON.stringify({ project_name: "t", genes_dir: "genes" }));
  addGene("to-granted", GRANTED_HOST);
  addGene("to-other", OTHER_HOST);
  addGene("to-other-b", OTHER_HOST);
  addAgent("granted-single", ["to-granted"], "Single");
  addAgent("other-single", ["to-other"], "Single");
  addAgent("other-pool", ["to-other", "to-other-b"], "TryPool");
  addAgent("other-par", ["to-other", "to-other-b"], "Par");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!tryLoadBinding() && !process.env.CI)("agent run holds a granted credential to its host", () => {
  it("lets the granted host through: the request reaches the network", async () => {
    const { output } = await agentRun("granted-single");
    expect(output).toMatch(LET_THROUGH);
    expect(output).not.toMatch(REFUSED);
  }, TIMEOUT);

  it("refuses another host the gene may reach, one gene at a time", async () => {
    const { output, code } = await agentRun("other-single");
    expect(code, output).not.toBe(0);
    expect(output).toMatch(REFUSED);
    expect(output).not.toContain(VALUE);
  }, TIMEOUT);

  it("refuses it in a TryPool", async () => {
    const { output, code } = await agentRun("other-pool");
    expect(code, output).not.toBe(0);
    // A TryPool prints only that its genes failed; why is in each gene's run log.
    for (const gene of ["to-other", "to-other-b"]) {
      expect(runLog(gene), `${gene}: ${output}`).toMatch(REFUSED);
      expect(runLog(gene)).not.toMatch(LET_THROUGH);
    }
    expect(output).not.toContain(VALUE);
  }, TIMEOUT);

  it("refuses it in a composition run by the algebra executor (Par)", async () => {
    const { output, code } = await agentRun("other-par");
    expect(code, output).not.toBe(0);
    expect(output).toMatch(REFUSED);
    expect(output).not.toMatch(LET_THROUGH);
    expect(output).not.toContain(VALUE);
  }, TIMEOUT);
});
