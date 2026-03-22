import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

import { LocalGeneItem } from "../../src/local-tree";
import { TreeItemCollapsibleState } from "vscode";

describe("LocalGeneItem", () => {
  it("creates a domain folder item", () => {
    const item = new LocalGeneItem("nlp (3)", TreeItemCollapsibleState.Collapsed, undefined, "nlp");
    expect(item.contextValue).toBe("localDomain");
    expect(item.domain).toBe("nlp");
  });

  it("creates a gene item with WASM", () => {
    const item = new LocalGeneItem("my-gene", TreeItemCollapsibleState.None, {
      name: "my-gene", path: "/test", domain: "nlp", version: "1.0.0",
      fidelity: "Native", description: "test", hasWasm: true, hasSource: true,
    });
    expect(item.contextValue).toBe("localGene");
    expect(item.description).toContain("v1.0.0");
    expect(item.description).toContain("Native");
  });

  it("marks published genes", () => {
    const item = new LocalGeneItem("pub-gene", TreeItemCollapsibleState.None, {
      name: "pub-gene", path: "/test", domain: "code", version: "2.0.0",
      fidelity: "Wrapped", description: "", hasWasm: false, hasSource: true,
      cloudId: "abc-123",
    });
    expect(item.contextValue).toBe("localGenePublished");
  });
});
