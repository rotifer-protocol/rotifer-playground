/**
 * The arena_entries upsert names its conflict target.
 *
 * tests/e2e/arena-submit-upsert.test.ts proves the behaviour against a real
 * PostgREST (a second submission of a gene updates its row instead of failing
 * with 409), but it needs a local stack and is skipped in CI. This pins the
 * request shape it depends on, so dropping `on_conflict=gene_id` fails CI too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("arenaSubmit upsert request", () => {
  const saved = {
    HOME: process.env.HOME,
    ROTIFER_CLOUD_ENDPOINT: process.env.ROTIFER_CLOUD_ENDPOINT,
    ROTIFER_CLOUD_ANON_KEY: process.env.ROTIFER_CLOUD_ANON_KEY,
  };
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "rotifer-upsert-url-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({ access_token: "test-token-not-real", expires_at: Date.now() + 3_600_000 }),
    );
    process.env.HOME = home;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes("/arena_entries")
        ? json([{ gene_id: "g-1", domain: "text.x", ...JSON.parse(String(init!.body)) }])
        : json([{ id: "g-1", name: "demo", domain: "text.x", profiles: { username: "someone" } }]),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("posts to arena_entries with on_conflict=gene_id and merge-duplicates", async () => {
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit("g-1", {
      value: 0.4, safety_score: 0.9, success_rate: 1, latency_score: 0.5, resource_efficiency: 0.5,
    });
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes("/arena_entries"))!;
    expect(new URL(String(url)).searchParams.get("on_conflict")).toBe("gene_id");
    expect(String((init as RequestInit).headers && (init as { headers: Record<string, string> }).headers.Prefer)).toContain(
      "resolution=merge-duplicates",
    );
  });
});
