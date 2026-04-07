import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "alpha-search",
    domain: "search.web",
    version: "0.2.0",
    fidelity: "Native",
    description: "demo gene",
    wasm_size: 1234,
    downloads: 7,
    reputation_score: 0.42,
    created_at: "2026-04-07T12:00:00Z",
    updated_at: "2026-04-07T12:00:00Z",
    owner_username: "alice",
    ...overrides,
  };
}

describe("cloud search client", () => {
  const originalHome = process.env.HOME;
  const originalEndpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
  const originalAnonKey = process.env.ROTIFER_CLOUD_ANON_KEY;

  let homeDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    homeDir = mkdtempSync(join(tmpdir(), "rotifer-cloud-search-"));
    process.env.HOME = homeDir;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(homeDir, { recursive: true, force: true });

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalEndpoint === undefined) delete process.env.ROTIFER_CLOUD_ENDPOINT;
    else process.env.ROTIFER_CLOUD_ENDPOINT = originalEndpoint;

    if (originalAnonKey === undefined) delete process.env.ROTIFER_CLOUD_ANON_KEY;
    else process.env.ROTIFER_CLOUD_ANON_KEY = originalAnonKey;
  });

  it("uses search_genes RPC and preserves exact totals from total_count", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([makeSearchRow({ total_count: 42 })]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { listGenes } = await import("../../src/cloud/client.js");
    const result = await listGenes({ query: "web", sort: "popular", page: 2, perPage: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloud.example.test/rest/v1/rpc/search_genes");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      p_query: "web",
      p_sort: "downloads",
      p_limit: 20,
      p_offset: 20,
    });

    expect(result.total).toBe(42);
    expect(result.total_exact).toBe(true);
    expect(result.page).toBe(2);
    expect(result.per_page).toBe(20);
    expect(result.genes[0].owner).toBe("alice");
  });

  it("derives an exact total from a short final page on legacy endpoints", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          makeSearchRow({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
          makeSearchRow({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "beta-search" }),
          makeSearchRow({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "gamma-search" }),
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const { listGenes } = await import("../../src/cloud/client.js");
    const result = await listGenes({ page: 2, perPage: 20 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(23);
    expect(result.total_exact).toBe(true);
  });

  it("rejects fitness as a misleading cloud search sort", async () => {
    const { listGenes } = await import("../../src/cloud/client.js");

    await expect(listGenes({ sort: "fitness" })).rejects.toThrow(
      /cannot sort by F\(g\)|arena list --cloud/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
