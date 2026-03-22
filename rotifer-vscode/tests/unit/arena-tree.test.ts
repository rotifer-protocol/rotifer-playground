import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

import { ArenaItem } from "../../src/arena-tree";
import { TreeItemCollapsibleState } from "vscode";

describe("ArenaItem", () => {
  it("creates a domain folder item", () => {
    const item = new ArenaItem("nlp (5)", TreeItemCollapsibleState.Collapsed, undefined, "nlp");
    expect(item.contextValue).toBe("arenaDomain");
    expect(item.domain).toBe("nlp");
  });

  it("creates an arena entry with medal icon for rank 1", () => {
    const item = new ArenaItem("#1 best-gene", TreeItemCollapsibleState.None, {
      rank: 1, gene_id: "1", gene_name: "best-gene", owner: "alice",
      domain: "nlp", fidelity: "Native", fitness: 0.95, safety: 0.9,
      reputation_score: 0.88,
    });
    expect(item.contextValue).toBe("arenaEntry");
    expect(item.description).toContain("F(g)=0.9500");
    expect(item.entry?.rank).toBe(1);
  });

  it("creates an arena entry for lower ranks", () => {
    const item = new ArenaItem("#5 ok-gene", TreeItemCollapsibleState.None, {
      rank: 5, gene_id: "5", gene_name: "ok-gene", owner: "bob",
      domain: "code", fidelity: "Wrapped", fitness: 0.6, safety: 0.5,
      reputation_score: null,
    });
    expect(item.description).toContain("F(g)=0.6000");
  });
});
