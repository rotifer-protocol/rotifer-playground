import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("trackDownload client", () => {
  const originalEndpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
  const originalAnonKey = process.env.ROTIFER_CLOUD_ANON_KEY;

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalEndpoint === undefined) delete process.env.ROTIFER_CLOUD_ENDPOINT;
    else process.env.ROTIFER_CLOUD_ENDPOINT = originalEndpoint;

    if (originalAnonKey === undefined) delete process.env.ROTIFER_CLOUD_ANON_KEY;
    else process.env.ROTIFER_CLOUD_ANON_KEY = originalAnonKey;
  });

  it("sends cli source by default", async () => {
    const { trackDownload } = await import("../../src/cloud/client.js");

    await trackDownload("11111111-1111-1111-1111-111111111111");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/rest/v1/rpc/track_download");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_gene_id: "11111111-1111-1111-1111-111111111111",
      p_source: "cli",
    });
  });

  it("allows explicit source overrides", async () => {
    const { trackDownload } = await import("../../src/cloud/client.js");

    await trackDownload("22222222-2222-2222-2222-222222222222", "mcp");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      p_gene_id: "22222222-2222-2222-2222-222222222222",
      p_source: "mcp",
    });
  });
});
