import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression tests for Issue #50 Bug 2 — `info` / `stats` / `compare`
 * silently treated `@owner/name` as a plain name. These tests pin the
 * URL/query shape that `getGene` emits for each ref kind, so the four
 * commands cannot regress to single-source-of-input parsing again.
 */

function geneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "scope-cli-2026",
    domain: "dev.tools",
    version: "0.1.0",
    fidelity: "Wrapped",
    description: "demo",
    phenotype: {},
    wasm_path: null,
    wasm_size: 0,
    wasm_hash: null,
    content_hash: null,
    downloads: 0,
    reputation_score: null,
    created_at: "2026-05-28T00:00:00Z",
    updated_at: "2026-05-28T00:00:00Z",
    profiles: { username: "xiaoba-dev" },
    ...overrides,
  };
}

describe("getGene ref-kind URL construction (Issue #50 Bug 2)", () => {
  const originalHome = process.env.HOME;
  const originalEndpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
  const originalAnonKey = process.env.ROTIFER_CLOUD_ANON_KEY;

  let homeDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    homeDir = mkdtempSync(join(tmpdir(), "rotifer-get-gene-"));
    process.env.HOME = homeDir;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([geneRow()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
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

  it("UUID ref queries by id only (no profiles filter)", async () => {
    const { getGene } = await import("../../src/cloud/client.js");
    await getGene("11111111-1111-1111-1111-111111111111");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("id=eq.11111111-1111-1111-1111-111111111111");
    expect(url).not.toContain("profiles.username");
    // UUID ref doesn't need ordering/limit because UUIDs are unique
    expect(url).not.toContain("order=");
    expect(url).not.toContain("limit=");
  });

  it("64-hex content_hash ref queries by content_hash", async () => {
    const { getGene } = await import("../../src/cloud/client.js");
    const hash = "a".repeat(64);
    await getGene(hash);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`content_hash=eq.${hash}`);
    expect(url).not.toContain("name=eq.");
    expect(url).not.toContain("profiles.username");
  });

  it("@owner/name ref applies BOTH name filter AND profiles.username inner-join filter", async () => {
    const { getGene } = await import("../../src/cloud/client.js");
    await getGene("@xiaoba-dev/scope-cli-2026");

    const url = String(fetchMock.mock.calls[0][0]);
    // Both halves of the @owner/name reference MUST end up in the query —
    // missing either lets the lookup match a different owner's gene with
    // the same name.
    expect(url).toContain("name=eq.scope-cli-2026");
    expect(url).toContain("profiles.username=eq.xiaoba-dev");
    // PostgREST embedded-resource filter requires !inner so the server
    // applies the username constraint instead of dropping it silently.
    expect(url).toContain("profiles%21inner%28username%29"); // URL-encoded
    expect(url).toContain("order=created_at.desc");
    expect(url).toContain("limit=1");
  });

  it("plain name ref keeps legacy name=eq query (no profiles filter)", async () => {
    const { getGene } = await import("../../src/cloud/client.js");
    await getGene("scope-cli-2026");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("name=eq.scope-cli-2026");
    expect(url).not.toContain("profiles.username");
    expect(url).toContain("order=created_at.desc");
    expect(url).toContain("limit=1");
  });

  it("returns 'Gene not found' message that quotes the original user input", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { getGene } = await import("../../src/cloud/client.js");
    await expect(getGene("@nobody/missing-gene")).rejects.toThrow(
      "Gene '@nobody/missing-gene' not found",
    );
  });
});

describe("getProfileByUsername (Issue #50 Bug 3 — reputation @username path)", () => {
  const originalHome = process.env.HOME;
  const originalEndpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
  const originalAnonKey = process.env.ROTIFER_CLOUD_ANON_KEY;

  let homeDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    homeDir = mkdtempSync(join(tmpdir(), "rotifer-profile-lookup-"));
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

  it("returns profile summary when username matches", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            username: "alice",
            avatar_url: "https://example.com/a.png",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { getProfileByUsername } = await import("../../src/cloud/client.js");
    const profile = await getProfileByUsername("alice");

    expect(profile).toEqual({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      avatar_url: "https://example.com/a.png",
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/profiles?");
    expect(url).toContain("username=eq.alice");
  });

  it("returns null when no profile matches (CLI can show a clean error)", async () => {
    fetchMock.mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { getProfileByUsername } = await import("../../src/cloud/client.js");
    const profile = await getProfileByUsername("nobody");
    expect(profile).toBeNull();
  });
});
