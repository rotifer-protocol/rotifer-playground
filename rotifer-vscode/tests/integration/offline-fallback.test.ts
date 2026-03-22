import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

describe("Integration: offline fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
  });

  it("ArenaTreeProvider returns empty children on network failure", async () => {
    const { ArenaTreeProvider } = await import("../../src/arena-tree");
    const { RotiferCloudClient } = await import("../../src/cloud-client");
    const client = new RotiferCloudClient();
    const provider = new ArenaTreeProvider(client);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].label).toContain("Failed to load");
  });

  it("deduplicateLatestVersion handles empty array", async () => {
    const { deduplicateLatestVersion } = await import("../../src/cloud-client");
    const result = deduplicateLatestVersion([]);
    expect(result).toEqual([]);
  });

  it("deduplicateLatestVersion handles single gene", async () => {
    const { deduplicateLatestVersion } = await import("../../src/cloud-client");
    const gene = {
      id: "abc",
      name: "test",
      owner_id: "owner",
      owner_username: "user",
      version: "1.0.0",
      domain: "general",
      fidelity: "Wrapped" as const,
      reputation_score: 50,
      created_at: "2026-01-01",
    };
    const result = deduplicateLatestVersion([gene]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("test");
  });
});
