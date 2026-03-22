import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

import { GeneTreeProvider, GeneTreeItem } from "../../src/gene-tree";
import { RotiferCloudClient, type CloudGene } from "../../src/cloud-client";

function makeGene(overrides: Partial<CloudGene> = {}): CloudGene {
  return {
    id: "id-1",
    name: "test-gene",
    owner: "alice",
    domain: "search.web",
    version: "0.1.0",
    fidelity: "Wrapped",
    description: "A test gene",
    phenotype: {},
    wasm_path: null,
    wasm_size: 0,
    downloads: 0,
    reputation_score: null,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("GeneTreeProvider", () => {
  it("groups genes by domain at top level", async () => {
    const client = new RotiferCloudClient();
    vi.spyOn(client, "listGenes").mockResolvedValue([
      makeGene({ name: "gene-a", domain: "search.web" }),
      makeGene({ name: "gene-b", domain: "nlp" }),
      makeGene({ name: "gene-c", domain: "search.web" }),
    ]);

    const provider = new GeneTreeProvider(client);
    const topLevel = await provider.getChildren();

    expect(topLevel).toHaveLength(2);
    const labels = topLevel.map((item) => item.label);
    expect(labels).toContain("nlp (1)");
    expect(labels).toContain("search.web (2)");
  });

  it("returns genes under a domain node", async () => {
    const client = new RotiferCloudClient();
    vi.spyOn(client, "listGenes").mockResolvedValue([
      makeGene({ name: "gene-a", domain: "search.web", reputation_score: 0.9 }),
      makeGene({ name: "gene-b", domain: "search.web", reputation_score: 0.5 }),
    ]);

    const provider = new GeneTreeProvider(client);
    const topLevel = await provider.getChildren();
    const domainNode = topLevel.find((item) => (item.label as string).startsWith("search.web"));
    expect(domainNode).toBeDefined();

    const children = await provider.getChildren(domainNode!);
    expect(children).toHaveLength(2);
    expect(children[0].gene?.name).toBe("gene-a");
  });
});
