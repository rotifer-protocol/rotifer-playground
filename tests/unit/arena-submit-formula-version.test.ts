/**
 * arena_entries.formula_version (ADR-345 D5, migration 20261027200000).
 *
 * The CLI says which F(g) formula produced the score it uploads, so rows from
 * the unnormalized formula (version 2) and the normalized one (version 3) can
 * be told apart without guessing from dates.
 *
 * A registry without the column yet answers PostgREST's PGRST204 ("Could not
 * find the 'formula_version' column … in the schema cache"). The CLI then
 * sends the same row once more without it, so a release does not have to wait
 * for the migration — and refuses to retry on any other error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPORT = {
  value: 0.3,
  safety_score: 0.9,
  success_rate: 1,
  latency_score: 0.5,
  resource_efficiency: 0.5,
  evaluation_method: "estimated" as const,
  formula_version: 3,
};

describe("arenaSubmit sends formula_version", () => {
  const saved = {
    HOME: process.env.HOME,
    ROTIFER_CLOUD_ENDPOINT: process.env.ROTIFER_CLOUD_ENDPOINT,
    ROTIFER_CLOUD_ANON_KEY: process.env.ROTIFER_CLOUD_ANON_KEY,
  };
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  /** What the registry answers to an arena_entries POST, given its body. */
  let answer: (body: Record<string, unknown>) => Response;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const arenaPosts = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).includes("/arena_entries"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "rotifer-formula-version-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({ access_token: "test-token-not-real", expires_at: Date.now() + 3_600_000 }),
    );
    process.env.HOME = home;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    answer = (body) => json([{ gene_id: "g-1", domain: "text.x", ...body }]);
    fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes("/arena_entries")
        ? answer(JSON.parse(String(init!.body)))
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

  it("puts formula_version in the row", async () => {
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit("g-1", REPORT);
    expect(arenaPosts()).toHaveLength(1);
    expect(arenaPosts()[0].formula_version).toBe(3);
  });

  it("sends the row again without it when the registry has no such column", async () => {
    answer = (body) =>
      "formula_version" in body
        ? json(
            {
              code: "PGRST204",
              details: null,
              hint: null,
              message: "Could not find the 'formula_version' column of 'arena_entries' in the schema cache",
            },
            400,
          )
        : json([{ gene_id: "g-1", domain: "text.x", ...body }]);
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    const entry = await arenaSubmit("g-1", REPORT);
    const posts = arenaPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0].formula_version).toBe(3);
    expect("formula_version" in posts[1]).toBe(false);
    expect({ ...posts[1], formula_version: 3 }).toEqual(posts[0]);
    expect(entry.fitness).toBe(0.3);
  });

  it("does not retry any other refusal", async () => {
    answer = () =>
      json({ code: "23514", message: 'new row for relation "arena_entries" violates check constraint' }, 400);
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await expect(arenaSubmit("g-1", REPORT)).rejects.toThrow(/400/);
    expect(arenaPosts()).toHaveLength(1);
  });

  it("is filled in by arena submit with the formula version that scored it", async () => {
    const { FITNESS_FORMULA_VERSION } = await import("../../src/utils/fitness-formula.js");
    expect(FITNESS_FORMULA_VERSION).toBe(3);
    const src = readFileSync(join(process.cwd(), "src/commands/arena-submit.ts"), "utf-8");
    expect(src).toContain("formula_version: FITNESS_FORMULA_VERSION");
  });
});
