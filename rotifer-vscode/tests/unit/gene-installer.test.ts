import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

import * as vscode from "vscode";
import { installGeneToWorkspace } from "../../src/gene-installer";
import type { CloudGene } from "../../src/cloud-client";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

function makeGene(overrides: Partial<CloudGene> = {}): CloudGene {
  return {
    id: "gene-uuid-1",
    name: "test-gene",
    owner: "alice",
    domain: "nlp",
    version: "1.0.0",
    fidelity: "Native",
    description: "A test gene",
    phenotype: { input: { type: "string" }, output: { type: "string" } },
    wasm_path: null,
    wasm_size: 0,
    downloads: 42,
    reputation_score: 0.85,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeClient(): any {
  return {
    downloadWasm: vi.fn().mockResolvedValue(Buffer.from("fake-wasm")),
  };
}

describe("installGeneToWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("creates genes directory with recursive flag", async () => {
    const gene = makeGene();
    await installGeneToWorkspace(gene, "/workspace", makeClient());
    expect(mkdirSync).toHaveBeenCalledWith(
      join("/workspace", "genes", "test-gene"),
      { recursive: true },
    );
  });

  it("writes phenotype.json with gene phenotype data", async () => {
    const gene = makeGene({ phenotype: { input: { type: "number" } } });
    await installGeneToWorkspace(gene, "/workspace", makeClient());
    const calls = vi.mocked(writeFileSync).mock.calls;
    const phenotypeCall = calls.find(([path]) => String(path).includes("phenotype.json"));
    expect(phenotypeCall).toBeDefined();
    const content = JSON.parse(phenotypeCall![1] as string);
    expect(content.input.type).toBe("number");
  });

  it("writes .cloud-manifest.json with gene metadata", async () => {
    const gene = makeGene({ id: "uuid-x", owner: "bob", version: "2.0.0" });
    await installGeneToWorkspace(gene, "/workspace", makeClient());
    const calls = vi.mocked(writeFileSync).mock.calls;
    const manifestCall = calls.find(([path]) => String(path).includes(".cloud-manifest.json"));
    expect(manifestCall).toBeDefined();
    const content = JSON.parse(manifestCall![1] as string);
    expect(content.cloud_id).toBe("uuid-x");
    expect(content.owner).toBe("bob");
    expect(content.version).toBe("2.0.0");
    expect(content.installed_at).toBeDefined();
  });

  it("returns the gene directory path", async () => {
    const gene = makeGene({ name: "my-gene" });
    const result = await installGeneToWorkspace(gene, "/workspace", makeClient());
    expect(result).toBe(join("/workspace", "genes", "my-gene"));
  });

  it("downloads WASM when gene has wasm_path", async () => {
    const gene = makeGene({ wasm_path: "genes/test-gene/gene.ir.wasm" });
    const client = makeClient();
    await installGeneToWorkspace(gene, "/workspace", client);
    expect(client.downloadWasm).toHaveBeenCalledWith("genes/test-gene/gene.ir.wasm");
    expect(vscode.window.withProgress).toHaveBeenCalled();
    const wasmCall = vi.mocked(writeFileSync).mock.calls.find(
      ([path]) => String(path).includes("gene.ir.wasm"),
    );
    expect(wasmCall).toBeDefined();
  });

  it("skips WASM download when gene has no wasm_path", async () => {
    const gene = makeGene({ wasm_path: null });
    const client = makeClient();
    await installGeneToWorkspace(gene, "/workspace", client);
    expect(client.downloadWasm).not.toHaveBeenCalled();
  });

  it("prompts for overwrite when gene directory already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Yes" as any);
    const gene = makeGene();
    await installGeneToWorkspace(gene, "/workspace", makeClient());
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "Yes",
      "No",
    );
  });

  it("throws when user declines overwrite", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("No" as any);
    const gene = makeGene();
    await expect(
      installGeneToWorkspace(gene, "/workspace", makeClient()),
    ).rejects.toThrow("Installation cancelled");
  });

  it("proceeds with installation when user confirms overwrite", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Yes" as any);
    const gene = makeGene();
    const result = await installGeneToWorkspace(gene, "/workspace", makeClient());
    expect(result).toContain("test-gene");
    expect(mkdirSync).toHaveBeenCalled();
  });
});
