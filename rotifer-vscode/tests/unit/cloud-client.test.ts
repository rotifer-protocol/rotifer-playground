import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

import { deduplicateLatestVersion, type CloudGene } from "../../src/cloud-client";

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

describe("deduplicateLatestVersion", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateLatestVersion([])).toEqual([]);
  });

  it("keeps latest version per owner+name", () => {
    const v1 = makeGene({ version: "0.1.0", created_at: "2025-01-01T00:00:00Z" });
    const v2 = makeGene({ version: "0.2.0", created_at: "2025-06-01T00:00:00Z" });
    const result = deduplicateLatestVersion([v1, v2]);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe("0.2.0");
  });

  it("keeps genes from different owners", () => {
    const alice = makeGene({ owner: "alice", created_at: "2025-01-01T00:00:00Z" });
    const bob = makeGene({ owner: "bob", created_at: "2025-06-01T00:00:00Z" });
    const result = deduplicateLatestVersion([alice, bob]);
    expect(result).toHaveLength(2);
  });

  it("sorts results by created_at descending", () => {
    const old = makeGene({ name: "old-gene", created_at: "2024-01-01T00:00:00Z" });
    const recent = makeGene({ name: "new-gene", created_at: "2025-12-01T00:00:00Z" });
    const result = deduplicateLatestVersion([old, recent]);
    expect(result[0].name).toBe("new-gene");
    expect(result[1].name).toBe("old-gene");
  });
});
