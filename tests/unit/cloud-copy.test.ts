import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listGenesMock, getGeneStatsMock } = vi.hoisted(() => ({
  listGenesMock: vi.fn(),
  getGeneStatsMock: vi.fn(),
}));

vi.mock("../../src/cloud/client.js", () => ({
  listGenes: listGenesMock,
  getGeneStats: getGeneStatsMock,
}));

import { searchCommand } from "../../src/commands/search.js";
import { statsCommand } from "../../src/commands/stats.js";

describe("cloud command copy", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    listGenesMock.mockReset();
    getGeneStatsMock.mockReset();
  });

  it("search shows a specific empty state with next steps", async () => {
    listGenesMock.mockResolvedValue({
      genes: [],
      total: 0,
      page: 1,
      per_page: 20,
      total_exact: true,
    });

    await searchCommand.parseAsync(["foo", "--domain", "web3"], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("No cloud genes matched this search.");
    expect(output).toContain("Search query: foo");
    expect(output).toContain("Domain filter: web3");
    expect(output).toContain("rotifer list");
  });

  it("search shows an exact page summary when total is authoritative", async () => {
    listGenesMock.mockResolvedValue({
      genes: [
        {
          name: "alpha-search",
          owner: "alice",
          domain: "search.web",
          version: "0.2.0",
          fidelity: "Native",
          reputation_score: 0.42,
          downloads: 7,
        },
      ],
      total: 42,
      page: 2,
      per_page: 20,
      total_exact: true,
    });

    await searchCommand.parseAsync(["alpha", "--page", "2"], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Page 2 · 1 of 42 cloud genes");
  });

  it("search avoids claiming an exact total when the endpoint cannot provide one", async () => {
    listGenesMock.mockResolvedValue({
      genes: [
        {
          name: "alpha-search",
          owner: "alice",
          domain: "search.web",
          version: "0.2.0",
          fidelity: "Native",
          reputation_score: 0.42,
          downloads: 7,
        },
      ],
      total: 20,
      page: 1,
      per_page: 20,
      total_exact: false,
    });

    await searchCommand.parseAsync(["alpha"], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Page 1 · showing 1 cloud genes");
    expect(output).not.toContain("1 of 20 cloud genes");
  });

  it("stats labels the input as gene ref", async () => {
    getGeneStatsMock.mockResolvedValue({
      last_7d: 3,
      last_30d: 8,
      last_90d: 13,
      total: 21,
    });

    await statsCommand.parseAsync(["wrapped-demo"], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Cloud Download Statistics");
    expect(output).toContain("Gene Ref");
    expect(output).not.toContain("Gene ID");
    expect(output).toContain("rotifer info wrapped-demo");
  });
});
