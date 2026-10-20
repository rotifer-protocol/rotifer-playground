import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

vi.mock("../../src/cloud/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cloud/client.js")>()),
  getGene: vi.fn(),
  downloadGeneWasm: vi.fn(),
  trackDownload: vi.fn(),
}));
vi.mock("../../src/utils/domain-suggest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/domain-suggest.js")>()),
  refreshDomainCacheFromCloud: vi.fn(async () => {}),
}));

import { getGene, downloadGeneWasm, trackDownload } from "../../src/cloud/client.js";
import { checkContentHash, contentHashWarning, installCommand, installGeneFromCloud } from "../../src/commands/install.js";
import { contentHash } from "../../src/utils/content-hash.js";
import type { CloudGene } from "../../src/cloud/types.js";
import { captureOutput } from "./genome-test-helpers.js";

const PHENOTYPE = { domain: "text.x", version: "1.0.0", fidelity: "Native", inputSchema: { type: "object" } };
const RECORDED = contentHash(PHENOTYPE);
/** Words the warning must never use: it shows disagreement, it vouches for nothing. */
const TRUST_WORDS = /verified|已验证|可信|trusted|trustworthy|authentic/i;

function gene(over: Partial<CloudGene> = {}): CloudGene {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "alpha",
    owner: "alice",
    domain: "text.x",
    version: "1.0.0",
    fidelity: "Native",
    description: null,
    phenotype: { ...PHENOTYPE },
    wasm_url: null,
    wasm_size: 0,
    wasm_hash: null,
    content_hash: RECORDED,
    downloads: 0,
    fitness: null,
    reputation_score: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

/** The same row, with one phenotype field changed after the hash was recorded. */
const tampered = () => gene({ phenotype: { ...PHENOTYPE, domain: "text.y" } });

describe("checkContentHash", () => {
  it("match when the phenotype hashes to the recorded value", () => {
    expect(checkContentHash(gene())).toEqual({ status: "match" });
  });

  it("mismatch when one phenotype field differs, with both values", () => {
    expect(checkContentHash(tampered())).toEqual({ status: "mismatch", recorded: RECORDED, recomputed: contentHash(tampered().phenotype) });
  });

  it("absent when the row has no content_hash", () => {
    expect(checkContentHash(gene({ content_hash: null }))).toEqual({ status: "absent" });
  });

  it("key order does not matter (the v1 algorithm sorts keys)", () => {
    const reordered = Object.fromEntries(Object.entries(PHENOTYPE).reverse());
    expect(checkContentHash(gene({ phenotype: reordered }))).toEqual({ status: "match" });
  });
});

describe("contentHashWarning wording", () => {
  it("names the gene, says it only shows disagreement, and claims no trust", () => {
    const text = contentHashWarning("alpha", checkContentHash(tampered()))!;
    expect(text).toContain("Gene 'alpha'");
    expect(text).toContain("can only show that the two disagree");
    expect(text).not.toMatch(TRUST_WORDS);
  });

  it("is silent for a match or an absent hash", () => {
    expect(contentHashWarning("alpha", { status: "match" })).toBeNull();
    expect(contentHashWarning("alpha", { status: "absent" })).toBeNull();
  });
});

describe("rotifer install compares phenotype and content_hash", () => {
  let root: string;
  let cwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = join(tmpdir(), `install-hash-${randomUUID()}`);
    mkdirSync(join(root, "genes"), { recursive: true });
    writeFileSync(join(root, "rotifer.json"), JSON.stringify({ name: "t", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "general" }));
    cwd = process.cwd();
    process.chdir(root);
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    vi.mocked(downloadGeneWasm).mockResolvedValue(Buffer.alloc(0));
    vi.mocked(trackDownload).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    exitSpy.mockRestore();
    process.exitCode = undefined;
    vi.mocked(getGene).mockReset();
  });

  async function install(): Promise<string> {
    const out = captureOutput();
    try {
      await installCommand.parseAsync(["node", "rotifer", "alpha"]);
      return out.text();
    } finally {
      out.restore();
    }
  }

  it("a changed phenotype field → warning naming the gene, install still succeeds with exit code 0", async () => {
    vi.mocked(getGene).mockResolvedValue(tampered());
    const text = await install();
    expect(text).toContain("Gene 'alpha': its phenotype does not match the content_hash");
    expect(text).toContain("Gene 'alpha' installed!");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    const warningLine = text.split("\n").find((l) => l.includes("does not match the content_hash"))!;
    expect(warningLine).not.toMatch(TRUST_WORDS);
  });

  it("an unchanged phenotype → no warning", async () => {
    vi.mocked(getGene).mockResolvedValue(gene());
    const text = await install();
    expect(text).not.toContain("does not match the content_hash");
    expect(text).toContain("Gene 'alpha' installed!");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("no recorded hash → a hint that there is nothing to compare, no warning", async () => {
    vi.mocked(getGene).mockResolvedValue(gene({ content_hash: null }));
    const text = await install();
    expect(text).toContain("No content_hash is recorded");
    expect(text).not.toContain("does not match the content_hash");
  });

  it("installGeneFromCloud returns the check for callers such as genome import", async () => {
    vi.mocked(getGene).mockResolvedValue(tampered());
    const r = await installGeneFromCloud("alpha", { genesDir: join(root, "genes") });
    expect(r.contentHashCheck.status).toBe("mismatch");
  });
});
