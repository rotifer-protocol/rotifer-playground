import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

vi.mock("../../src/cloud/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cloud/client.js")>()),
  getGene: vi.fn(),
  downloadGeneWasm: vi.fn(),
  trackDownload: vi.fn(),
}));

import { downloadGeneWasm, getGene, trackDownload } from "../../src/cloud/client.js";
import { GeneExistsError, WasmIntegrityError, installGeneFromCloud } from "../../src/commands/install.js";
import type { CloudGene } from "../../src/cloud/types.js";

const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

function gene(over: Partial<CloudGene> = {}): CloudGene {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "alpha",
    owner: "alice",
    domain: "text.x",
    version: "1.0.0",
    fidelity: "Native",
    description: null,
    phenotype: { domain: "text.x", fidelity: "Native" },
    wasm_url: "https://example.test/alpha.wasm",
    wasm_size: WASM.length,
    wasm_hash: createHash("sha256").update(WASM).digest("hex"),
    content_hash: null,
    downloads: 0,
    fitness: null,
    reputation_score: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

let genesDir: string;

beforeEach(() => {
  genesDir = join(tmpdir(), `install-core-${randomUUID()}`, "genes");
  mkdirSync(genesDir, { recursive: true });
  vi.mocked(getGene).mockResolvedValue(gene());
  vi.mocked(downloadGeneWasm).mockResolvedValue(WASM);
  vi.mocked(trackDownload).mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(join(genesDir, ".."), { recursive: true, force: true });
  vi.mocked(getGene).mockReset();
  vi.mocked(downloadGeneWasm).mockReset();
  vi.mocked(trackDownload).mockReset();
});

describe("installGeneFromCloud", () => {
  it("writes phenotype, verified WASM and manifest, and counts the download", async () => {
    const onFetched = vi.fn();
    const { gene: g, geneDir, didSnapshot } = await installGeneFromCloud("alpha-ref", { genesDir, onFetched });
    expect(g.name).toBe("alpha");
    expect(onFetched).toHaveBeenCalledOnce();
    expect(didSnapshot).toBe(false);
    expect(JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"))).toEqual({ domain: "text.x", fidelity: "Native" });
    expect(readFileSync(join(geneDir, "gene.ir.wasm"))).toEqual(WASM);
    expect(JSON.parse(readFileSync(join(geneDir, ".cloud-manifest.json"), "utf-8"))).toMatchObject({
      cloud_id: g.id,
      owner: "alice",
      version: "1.0.0",
    });
    expect(trackDownload).toHaveBeenCalledWith(g.id, "cli");
  });

  it("refuses to overwrite an existing gene without force", async () => {
    mkdirSync(join(genesDir, "alpha"));
    await expect(installGeneFromCloud("alpha-ref", { genesDir })).rejects.toBeInstanceOf(GeneExistsError);
    expect(trackDownload).not.toHaveBeenCalled();
  });

  it("a size mismatch is an integrity error and writes no WASM", async () => {
    vi.mocked(getGene).mockResolvedValue(gene({ wasm_size: WASM.length + 1 }));
    await expect(installGeneFromCloud("alpha-ref", { genesDir })).rejects.toThrow(WasmIntegrityError);
    expect(existsSync(join(genesDir, "alpha", "gene.ir.wasm"))).toBe(false);
    expect(trackDownload).not.toHaveBeenCalled();
  });

  it("a hash mismatch is an integrity error", async () => {
    vi.mocked(getGene).mockResolvedValue(gene({ wasm_hash: "0".repeat(64) }));
    await expect(installGeneFromCloud("alpha-ref", { genesDir })).rejects.toThrow("hash mismatch");
  });

  it("a gene without an artifact installs phenotype and manifest only", async () => {
    vi.mocked(getGene).mockResolvedValue(gene({ wasm_url: null }));
    const { geneDir } = await installGeneFromCloud("alpha-ref", { genesDir });
    expect(existsSync(join(geneDir, "gene.ir.wasm"))).toBe(false);
    expect(existsSync(join(geneDir, ".cloud-manifest.json"))).toBe(true);
    expect(downloadGeneWasm).not.toHaveBeenCalled();
  });

  it("with force, the old copy is snapshotted before the overwrite", async () => {
    mkdirSync(join(genesDir, "alpha"));
    writeFileSync(join(genesDir, "alpha", "phenotype.json"), "{}");
    const { didSnapshot } = await installGeneFromCloud("alpha-ref", { genesDir, force: true });
    expect(didSnapshot).toBe(true);
  });
});
