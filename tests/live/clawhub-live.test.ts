import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { announceSimulation, simulatedService, type SimulatedService } from "./simulate.js";

/**
 * The real ClawHub, on a schedule (.github/workflows/live-checks.yml), not in
 * the PR gate: its backend fails about one request in six with HTTP 500 and
 * takes 4–11 s when it works (measured 2026-10-31). The PR gate runs the same
 * CLI path against a recorded ClawHub (tests/e2e/clawhub-wrap.test.ts); this
 * suite is what notices when the real one changes — a new redirect, a new
 * response shape, a moved host — or stays down. The CLI retries transient
 * failures and prints the real status, so a failure here says what ClawHub
 * answered.
 *
 * "grilling" (@wufei-png) is a small, stable, real listing.
 */

const CLI = join(__dirname, "../../dist/index.js");
const TMP = join(tmpdir(), `rotifer-clawhub-live-${Date.now()}`);
// Only for live-checks.yml's simulate_failure input; see simulate.ts.
let sim: SimulatedService | null = null;

function run(args: string[]): Promise<string> {
  const env = { ...process.env, NO_COLOR: "1" };
  // The real endpoints, whatever the environment says.
  delete env.ROTIFER_CLAWHUB_API_URL;
  delete env.ROTIFER_CLAWHUB_DOWNLOAD_URL;
  if (sim) {
    env.ROTIFER_CLAWHUB_API_URL = `${sim.url}/api/skill`;
    env.ROTIFER_CLAWHUB_DOWNLOAD_URL = `${sim.url}/api/v1/download`;
  }
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { cwd: TMP, timeout: 150_000, env }, (_err, stdout, stderr) =>
      resolve(`${stdout}${stderr}`),
    );
  });
}

beforeAll(async () => {
  mkdirSync(join(TMP, "genes"), { recursive: true });
  writeFileSync(
    join(TMP, "rotifer.json"),
    JSON.stringify({ name: "clawhub-live", genes_dir: "genes", default_domain: "general", author: "test" }),
  );
  sim = await simulatedService();
  if (sim) announceSimulation(sim, "ClawHub");
});

afterAll(async () => {
  await sim?.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("live ClawHub", () => {
  it("a slug that does not exist is reported as not found (HTTP 404)", async () => {
    const output = await run(["wrap", "live-missing", "--from-clawhub", "this-slug-does-not-exist-ever-999"]);
    expect(output, output).toContain("E0010");
    expect(output, output).toContain("not found (HTTP 404)");
  });

  it("wrap --from-clawhub grilling downloads, unpacks and writes the gene", async () => {
    const geneDir = join(TMP, "genes", "clawhub-real-gene");
    const output = await run(["wrap", "clawhub-real-gene", "--from-clawhub", "grilling"]);
    expect(output, output).toContain("Grilling");
    expect(existsSync(join(geneDir, "phenotype.json")), output).toBe(true);
    const phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
    expect(phenotype.source).toBe("clawhub");
    expect(phenotype.clawhub.slug).toBe("grilling");
    expect(phenotype.clawhub.originalAuthor).toBeDefined();
    expect(phenotype.clawhub.downloads).toBeTypeOf("number");
    const manifest = JSON.parse(readFileSync(join(geneDir, ".gene-manifest.json"), "utf-8"));
    expect(manifest.fromClawhub).toBeDefined();
    expect(manifest.clawhubVersion).toBeDefined();
  });
});
