import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The acceptance test for ADR-319 plan item 2.6: an author can take their own
 * version down, and anyone else is refused.
 *
 * The refusal is the interesting half. RLS narrows the UPDATE to rows the
 * caller owns, and in PostgREST an UPDATE matching nothing is not an error —
 * with `Prefer: return=minimal` it answers 204, byte-identical to a successful
 * one. Verified against production: a PATCH matching zero rows returns 204 with
 * `return=minimal` and `200 []` with `return=representation`. So the old code
 * would have told someone unpublishing a gene they do not own that it worked.
 */

const OWNED_ROW = { id: "gene-1", name: "demo", version: "1.0.0" };

describe("unpublishGene", () => {
  const originalEndpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
  const originalAnonKey = process.env.ROTIFER_CLOUD_ANON_KEY;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    vi.doMock("../../src/cloud/auth.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/cloud/auth.js")>(
        "../../src/cloud/auth.js"
      );
      return {
        ...actual,
        loadCredentials: () => ({
          access_token: "token",
          refresh_token: "refresh",
          user: { id: "owner-1", username: "tester" },
        }),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../src/cloud/auth.js");
    if (originalEndpoint === undefined) delete process.env.ROTIFER_CLOUD_ENDPOINT;
    else process.env.ROTIFER_CLOUD_ENDPOINT = originalEndpoint;
    if (originalAnonKey === undefined) delete process.env.ROTIFER_CLOUD_ANON_KEY;
    else process.env.ROTIFER_CLOUD_ANON_KEY = originalAnonKey;
  });

  it("returns the version the server actually changed", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([OWNED_ROW]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unpublishGene } = await import("../../src/cloud/client.js");
    await expect(unpublishGene("gene-1")).resolves.toEqual(OWNED_ROW);
  });

  /** The regression: silence used to read as success. */
  it("refuses to report success when RLS matched no rows", async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { unpublishGene } = await import("../../src/cloud/client.js");
    await expect(unpublishGene("someone-elses-gene")).rejects.toThrow(
      /Nothing was unpublished.*changed no row/s
    );
  });

  /**
   * This test used to assert a PATCH to `/genes?id=eq.…` carrying
   * `{ published: false }`. That request was refused by
   * `trg_version_immutability` every single time it was sent, and the assertion
   * passed anyway because the reply was a mock. What a mocked test can honestly
   * check is the wire shape; whether the server accepts it is settled in
   * `supabase/tests/gene_visibility_unpublish.sql` against a real database.
   */
  it("calls the audited RPC, with the argument names the function declares", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([OWNED_ROW]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unpublishGene } = await import("../../src/cloud/client.js");
    await unpublishGene("gene-1", "superseded");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/rpc/unpublish_gene");
    expect(init.method).toBe("POST");
    // PostgREST matches these names against the function signature; a typo here
    // is a 404 from the server, not a TypeScript error.
    expect(JSON.parse(init.body)).toEqual({ p_gene_id: "gene-1", p_reason: "superseded" });
  });

  it("sends an explicit null when no reason is given", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([OWNED_ROW]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unpublishGene } = await import("../../src/cloud/client.js");
    await unpublishGene("gene-1");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ p_gene_id: "gene-1", p_reason: null });
  });

  /**
   * An unpublished gene keeps its Arena row, and §9.7.1 asks that a published
   * score stay recomputable. Deleting the binary would strand a score with no
   * way to check it and blind the `async-express-artifact` criterion, which
   * reads exactly that file.
   */
  it("leaves the published artifact in storage", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([OWNED_ROW]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unpublishGene } = await import("../../src/cloud/client.js");
    await unpublishGene("gene-1");

    const storageCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/storage/"));
    expect(storageCalls).toEqual([]);
    const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toEqual([]);
  });

  it("surfaces a genuine server error rather than swallowing it", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response("permission denied", { status: 403 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unpublishGene } = await import("../../src/cloud/client.js");
    await expect(unpublishGene("gene-1")).rejects.toThrow(/Failed to unpublish gene/);
  });
});

describe("republishGene", () => {
  const originalEndpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
  const originalAnonKey = process.env.ROTIFER_CLOUD_ANON_KEY;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    vi.doMock("../../src/cloud/auth.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/cloud/auth.js")>(
        "../../src/cloud/auth.js"
      );
      return {
        ...actual,
        loadCredentials: () => ({
          access_token: "token",
          refresh_token: "refresh",
          user: { id: "owner-1", username: "tester" },
        }),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../src/cloud/auth.js");
    if (originalEndpoint === undefined) delete process.env.ROTIFER_CLOUD_ENDPOINT;
    else process.env.ROTIFER_CLOUD_ENDPOINT = originalEndpoint;
    if (originalAnonKey === undefined) delete process.env.ROTIFER_CLOUD_ANON_KEY;
    else process.env.ROTIFER_CLOUD_ANON_KEY = originalAnonKey;
  });

  it("flips only the published flag, so the artifact and hash are unchanged", async () => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([OWNED_ROW]), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { republishGene } = await import("../../src/cloud/client.js");
    await expect(republishGene("gene-1")).resolves.toEqual(OWNED_ROW);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/rpc/republish_gene");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ p_gene_id: "gene-1", p_reason: null });
  });

  /** Same silent-success trap as unpublish, so the same guard. */
  it("refuses to report success when the server changed no row", async () => {
    fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { republishGene } = await import("../../src/cloud/client.js");
    await expect(republishGene("someone-elses-gene")).rejects.toThrow(
      /Nothing was republished.*not yours or does not exist/s
    );
  });
});
