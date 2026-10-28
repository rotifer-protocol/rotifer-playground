/**
 * arena_entries.formula_version (ADR-346 D5, migration 20261027200000).
 *
 * The CLI says which F(g) formula produced the score it uploads, so rows from
 * the unnormalized formula (version 2) and the normalized one (version 3) can
 * be told apart without guessing from dates.
 *
 * It says so in the X-Rotifer-Formula-Version request header, not in the row:
 * the registry's write guard labels the row from the header on every client
 * write and clears the label when a write carries none, and the client has no
 * privilege on the column. supabase/tests/arena_formula_version.sql covers
 * the registry side.
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
  const arenaCalls = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).includes("/arena_entries"))
      .map(([, init]) => init as RequestInit);
  const arenaPosts = () =>
    arenaCalls().map((init) => JSON.parse(String(init.body)) as Record<string, unknown>);
  const versionHeader = (init: RequestInit) =>
    new Headers(init.headers).get("x-rotifer-formula-version");

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

  it("sends formula_version as the X-Rotifer-Formula-Version header", async () => {
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit("g-1", REPORT);
    expect(arenaCalls()).toHaveLength(1);
    expect(versionHeader(arenaCalls()[0])).toBe("3");
  });

  it("leaves it out of the row, where the client has no privilege to write it", async () => {
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit("g-1", REPORT);
    expect("formula_version" in arenaPosts()[0]).toBe(false);
    expect(arenaPosts()[0].fitness_value).toBe(0.3);
  });

  it("sends no version header when the report names no version", async () => {
    const { formula_version: _none, ...unversioned } = REPORT;
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit("g-1", unversioned);
    expect(versionHeader(arenaCalls()[0])).toBeNull();
  });

  it("is filled in by arena submit with the formula version that scored it", async () => {
    const { FITNESS_FORMULA_VERSION } = await import("../../src/utils/fitness-formula.js");
    expect(FITNESS_FORMULA_VERSION).toBe(3);
    const src = readFileSync(join(process.cwd(), "src/commands/arena-submit.ts"), "utf-8");
    expect(src).toContain("formula_version: FITNESS_FORMULA_VERSION");
  });
});
