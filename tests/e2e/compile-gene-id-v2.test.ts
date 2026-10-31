/**
 * `rotifer compile` names the gene by its v2 content ID (docs/gene-id-v2.md)
 * — the ID agent memory records as createdBy, P2P announces
 * and `rotifer wrap` prints — not the unprefixed hash of phenotype.json
 * that §6 of that document lists as superseded.
 *
 * It still prints that hash, on its own line labelled as what it is: the
 * content_hash `rotifer publish` sends (docs/content-hash-v1.md, ADR-341),
 * of phenotype.json as it stands — not an identity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { geneIdV2, hasNativeGeneIdV2, tryLoadBinding } from "../../src/utils/binding.js";
import { canonicalSerialize, contentHash } from "../../src/utils/content-hash.js";
import { cliEnv } from "../fixtures/memory/cli.js";
import { memoryGeneWasm, writeRequest } from "../fixtures/memory/wasm-memory-gene.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");
const BYO_PHENOTYPE = { domain: "memory.demo", inputSchema: { type: "object" }, outputSchema: {}, version: "0.1.0", fidelity: "Native" };
const BYO_WASM = memoryGeneWasm([{ op: "write", request: writeRequest("k", "v") }]);

describe("rotifer compile prints the v2 gene ID, and the content hash as what it is", () => {
  let project: string;
  const compile = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, "compile", ...args], { cwd: project, env: cliEnv, encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return r.stdout;
  };

  beforeAll(() => {
    expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
    expect(hasNativeGeneIdV2(), "the native addon computes v2 IDs").toBe(true);
    project = join(tmpdir(), "rotifer-compile-id-" + randomUUID());
    mkdirSync(join(project, "genes"), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "ids", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
    );
    cpSync(join(ROOT, "genes", "memory-preference-demo"), join(project, "genes", "memory-preference-demo"), { recursive: true });
    mkdirSync(join(project, "genes", "byo"), { recursive: true });
    writeFileSync(join(project, "genes", "byo", "phenotype.json"), JSON.stringify(BYO_PHENOTYPE));
    writeFileSync(join(project, "byo.wasm"), BYO_WASM);
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  /** contentHash of the gene's phenotype.json as it stands now — what publish would send. */
  const fileHash = (gene: string) => contentHash(JSON.parse(readFileSync(join(project, "genes", gene, "phenotype.json"), "utf-8")));
  const contentHashLine = (hash: string) =>
    new RegExp(`Content hash: ${hash} \\(phenotype\\.json as publish sends it — not an identity\\)`);

  it("a compiled (BYO WASM) gene: the v2 ID of the module it wrote, not the phenotype hash", () => {
    const out = compile("byo", "--wasm", join(project, "byo.wasm"));
    const id = geneIdV2(join(project, "genes"), "byo") as { id: string };
    expect(out).toContain(`Gene ID (v2): ${id.id}`);
    // compile has just written irHash into phenotype.json — the native IR
    // compiler's hash of this module and phenotype, recomputed here from the
    // same input, and the value in .compile-result.json — and the content
    // hash covers the file as written.
    const expectedIrHash = tryLoadBinding()!.compileGene(Buffer.from(BYO_WASM), canonicalSerialize(BYO_PHENOTYPE)).irHash;
    expect(expectedIrHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(project, "genes", "byo", "phenotype.json"), "utf-8")).irHash).toBe(expectedIrHash);
    expect(JSON.parse(readFileSync(join(project, "genes", "byo", ".compile-result.json"), "utf-8")).irHash).toBe(expectedIrHash);
    expect(out).toMatch(contentHashLine(fileHash("byo")));
    expect(out).not.toMatch(/^\s*Gene ID:/m);
    expect(out).not.toContain(contentHash(BYO_PHENOTYPE));
  });

  it("--check on a Wrapped gene: the same v2 ID agent memory records as createdBy", () => {
    const out = compile("memory-preference-demo", "--check");
    const id = geneIdV2(join(project, "genes"), "memory-preference-demo") as { id: string };
    expect(out).toContain(`Gene ID (v2): ${id.id}`);
    expect(out).toMatch(contentHashLine(fileHash("memory-preference-demo")));
    expect(out).not.toMatch(/^\s*Gene ID:/m);
  });

  it("a Hybrid gene (validated, no WASM): both lines too", () => {
    mkdirSync(join(project, "genes", "hybrid"), { recursive: true });
    writeFileSync(
      join(project, "genes", "hybrid", "phenotype.json"),
      JSON.stringify({
        domain: "memory.demo",
        inputSchema: { type: "object" },
        outputSchema: {},
        version: "0.1.0",
        fidelity: "Hybrid",
        network: { allowedDomains: ["api.example.com"] },
      }),
    );
    writeFileSync(join(project, "genes", "hybrid", "index.ts"), "export async function express() { return {}; }\n");
    const out = compile("hybrid");
    expect(out).toContain("Gene ID (v2):");
    expect(out).toMatch(contentHashLine(fileHash("hybrid")));
    expect(out).not.toMatch(/^\s*Gene ID:/m);
  });
});
