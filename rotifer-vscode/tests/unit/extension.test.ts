import { describe, it, expect } from "vitest";
import { renderGeneDetails, renderReputationPanel, renderGeneStats, renderVersionHistory, renderLeaderboard, renderMyReputation, renderCompare } from "../../src/webviews";

describe("renderGeneDetails", () => {
  it("includes gene name and domain", () => {
    const html = renderGeneDetails({
      id: "1", name: "test-gene", owner: "alice", domain: "nlp", version: "1.0.0",
      fidelity: "Native", description: "A test gene", phenotype: {}, wasm_path: null,
      wasm_size: 0, downloads: 42, reputation_score: 0.85, created_at: "2025-01-01",
    });
    expect(html).toContain("test-gene");
    expect(html).toContain("nlp");
    expect(html).toContain("alice");
    expect(html).toContain("42");
    expect(html).toContain("0.8500");
  });

  it("handles missing optional fields", () => {
    const html = renderGeneDetails({
      id: "2", name: "bare", owner: "unknown", domain: "code", version: "0.1.0",
      fidelity: "Wrapped", description: "", phenotype: {}, wasm_path: null,
      wasm_size: 0, downloads: 0, reputation_score: null, created_at: "2025-01-01",
    });
    expect(html).toContain("bare");
    expect(html).toContain("N/A");
  });
});

describe("renderReputationPanel", () => {
  it("renders score and breakdown bars", () => {
    const html = renderReputationPanel("test-gene", {
      score: 0.75, arenaScore: 0.6, usageScore: 0.8, stabilityScore: 0.9,
      epoch: 3, computedAt: "2025-06-01T00:00:00Z",
    });
    expect(html).toContain("75.0");
    expect(html).toContain("Arena");
    expect(html).toContain("Usage");
    expect(html).toContain("Stability");
    expect(html).toContain("Epoch 3");
  });

  it("clamps bar width at 100%", () => {
    const html = renderReputationPanel("over", {
      score: 1.2, arenaScore: 1.5, usageScore: 0.5, stabilityScore: 0.5,
      epoch: 1, computedAt: "2025-01-01T00:00:00Z",
    });
    expect(html).toContain("width:100%");
  });
});

describe("renderGeneStats", () => {
  it("renders all time periods", () => {
    const html = renderGeneStats("my-gene", { total: 100, last_7d: 10, last_30d: 40, last_90d: 80 });
    expect(html).toContain("Last 7 days");
    expect(html).toContain("Last 30 days");
    expect(html).toContain("Last 90 days");
    expect(html).toContain("All time");
    expect(html).toContain("100");
    expect(html).toContain("my-gene");
  });
});

describe("renderVersionHistory", () => {
  it("renders version chain", () => {
    const html = renderVersionHistory("alice", "my-gene", [
      { id: "1", version: "0.1.0", changelog: "Initial", previous_version_id: null, created_at: "2025-01-01" },
      { id: "2", version: "0.2.0", changelog: "Bug fix", previous_version_id: "1", created_at: "2025-02-01" },
    ]);
    expect(html).toContain("0.1.0");
    expect(html).toContain("0.2.0");
    expect(html).toContain("Initial");
    expect(html).toContain("Bug fix");
    expect(html).toContain("2 version(s)");
  });

  it("handles empty versions", () => {
    const html = renderVersionHistory("bob", "nothing", []);
    expect(html).toContain("No published versions found");
  });
});

describe("renderLeaderboard", () => {
  it("renders ranked creators", () => {
    const html = renderLeaderboard([
      { username: "alice", avatar_url: null, score: 0.95, genes_published: 10, total_downloads: 500, arena_wins: 5 },
      { username: "bob", avatar_url: null, score: 0.80, genes_published: 5, total_downloads: 200, arena_wins: 2 },
    ]);
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("2 creators");
  });
});

describe("renderMyReputation", () => {
  it("renders personal stats", () => {
    const html = renderMyReputation("alice", {
      score: 0.88, genes_published: 8, total_downloads: 350, arena_wins: 4, community_bonus: 0.05,
    });
    expect(html).toContain("@alice");
    expect(html).toContain("88.0");
    expect(html).toContain("350");
  });
});

describe("renderCompare", () => {
  it("renders comparison table", () => {
    const html = renderCompare([
      { id: "1", name: "gene-a", owner: "alice", domain: "nlp", version: "1.0.0", fidelity: "Native", description: "", phenotype: {}, wasm_path: null, wasm_size: 1024, downloads: 100, reputation_score: 0.9, created_at: "" },
      { id: "2", name: "gene-b", owner: "bob", domain: "nlp", version: "2.0.0", fidelity: "Wrapped", description: "", phenotype: {}, wasm_path: null, wasm_size: 0, downloads: 50, reputation_score: 0.7, created_at: "" },
    ]);
    expect(html).toContain("gene-a");
    expect(html).toContain("gene-b");
    expect(html).toContain("Highest reputation");
    expect(html).toContain("gene-a");
  });
});
