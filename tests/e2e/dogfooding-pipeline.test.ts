import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryLoadBinding } from "../../src/utils/binding.js";

const ROOT = process.cwd();
const CLI = "node dist/index.js";

// These Genes are Cloud-installed (they carry .cloud-manifest.json), so a run
// here is a real invocation as far as the reporter is concerned. On 2026-08-18
// one `npm test` by a signed-in developer put four rows into production. The
// reporter now refuses to report under a test runner on its own, but say it at
// the call site too: this suite must never contribute traffic to §33.4 metrics.
function cli(args: string): string {
  return execSync(`${CLI} ${args}`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ROTIFER_TELEMETRY: "0" },
  });
}

const PIPELINE = ["doc-retrieval", "answer-synthesizer", "source-linker", "grammar-checker"];
const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);

// The runs below also need the native addon, and not because they execute WASM —
// they don't. These Genes are Cloud-installed, and with no addon the L0 gate
// cannot run at all; provenance then decides, and someone else's code does not
// get to run unchecked with full host privileges. Refusing them is the intended
// behaviour, so an addon-less environment is simply outside what these cases
// cover. The release branch is one such environment: `npm install
// --package-lock-only` silently drops the @rotifer/playground-* entries whose
// new version is not published yet, so `npm ci` installs no addon.
// Ask the loader the CLI itself uses. Deriving the package name here instead —
// `playground-${platform}-${arch}` — silently skipped these cases everywhere,
// because two of the four platform packages don't follow that shape
// (`linux-x64-gnu`, `win32-x64-msvc`). The suite went green by not running.
const hasNativeAddon = tryLoadBinding() !== null;
const skipRuntime = nodeVersion < 22 || !hasNativeAddon;

describe("Dogfooding Pipeline", () => {
  it("all 4 genes have phenotype.json", () => {
    for (const g of PIPELINE) {
      const p = join(ROOT, "genes", g, "phenotype.json");
      expect(existsSync(p), `missing: ${p}`).toBe(true);
      const d = JSON.parse(readFileSync(p, "utf-8"));
      expect(d.inputSchema, `${g} missing inputSchema`).toBeDefined();
      expect(d.outputSchema, `${g} missing outputSchema`).toBeDefined();
    }
  });

  it("hybrid genes declare network config", () => {
    for (const g of ["doc-retrieval", "answer-synthesizer"]) {
      const d = JSON.parse(readFileSync(join(ROOT, "genes", g, "phenotype.json"), "utf-8"));
      expect(d.fidelity).toBe("Hybrid");
      expect(d.network?.allowedDomains?.length).toBeGreaterThan(0);
    }
  });

  it("native genes have no network config", () => {
    for (const g of ["source-linker", "grammar-checker"]) {
      const d = JSON.parse(readFileSync(join(ROOT, "genes", g, "phenotype.json"), "utf-8"));
      expect(d.network).toBeUndefined();
    }
  });

  it("schema chain: each output satisfies next input required fields", () => {
    for (let i = 0; i < PIPELINE.length - 1; i++) {
      const pOut = JSON.parse(readFileSync(join(ROOT, "genes", PIPELINE[i], "phenotype.json"), "utf-8"));
      const cIn = JSON.parse(readFileSync(join(ROOT, "genes", PIPELINE[i + 1], "phenotype.json"), "utf-8"));
      const outKeys = Object.keys(pOut.outputSchema?.properties || {});
      const reqKeys: string[] = cIn.inputSchema?.required || [];
      for (const k of reqKeys) {
        expect(outKeys, `${PIPELINE[i]} output missing "${k}" needed by ${PIPELINE[i + 1]}`).toContain(k);
      }
    }
  });

  it("CLI: agent create docs-assistant (Seq)", () => {
    const out = cli("agent create dogfood-e2e-test --genes doc-retrieval answer-synthesizer source-linker grammar-checker --composition Seq");
    expect(out).toContain("created");
    expect(out).toContain("Seq");
  });

  it.skipIf(skipRuntime)("CLI: source-linker solo run (no API keys needed)", () => {
    cli("agent create sl-e2e-test --genes source-linker");
    const input = JSON.stringify({
      answer: "A Gene is the atomic unit of capability in Rotifer.",
      sources: ["docs/getting-started.md", "README.md"],
      confidence: 0.9,
    });
    const out = cli(`agent run sl-e2e-test --input '${input}'`);
    expect(out).toContain("Pipeline execution complete");
    expect(out).toContain("source-linker");
    expect(out).toMatch(/Getting Started|links/);
  });

  it.skipIf(skipRuntime)("CLI: grammar-checker solo run (no API keys needed)", () => {
    cli("agent create gc-e2e-test --genes grammar-checker");
    const input = JSON.stringify({ text: "This are a test sentance with erors." });
    const out = cli(`agent run gc-e2e-test --input '${input}'`);
    expect(out).toContain("Pipeline execution complete");
    expect(out).toContain("grammar-checker");
  });

  it.skipIf(skipRuntime)("CLI: source-linker → grammar-checker 2-gene Seq (no API keys)", () => {
    cli("agent create sl-gc-e2e-test --genes source-linker grammar-checker --composition Seq");
    const input = JSON.stringify({
      answer: "This are a test sentance about genes.",
      sources: ["docs/getting-started.md"],
      confidence: 0.8,
    });
    const out = cli(`agent run sl-gc-e2e-test --input '${input}'`);
    expect(out).toContain("Pipeline execution complete");
    expect(out).toContain("2");
  });
});
