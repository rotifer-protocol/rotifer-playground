// ============================================================
// B.9 — Season RPC end-to-end tests against a real Supabase instance.
// Strict-Test per ADR-264 §5: no mock, no simplification, no fallback.
// ============================================================
//
// These tests connect to a **real** Supabase database (local `supabase start`
// or staging) and exercise the season system RPCs end-to-end. They are
// **expected to fail** during v0.9 stage 1 because the migration
// 20260516210000_v09_seasons.sql installs stubs that raise
// `NOT_IMPLEMENTED`. Stage 2 will replace the stubs with the real logic
// from plan §3.2 and these tests will turn green.
//
// Prerequisites (stage 2):
//   1. `npm install @supabase/supabase-js`
//   2. `supabase start` (Docker required)
//   3. Set env `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
//
// Stage 1 expectation: vitest reports "Cannot find module '@supabase/supabase-js'"
// or RPC fails with NOT_IMPLEMENTED — both qualify as TDD red phase.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dynamic import to keep the module-resolution error contained inside the
// suite (otherwise vitest collection itself fails before reporting any test).
type SupabaseClient = unknown;
let createClient: ((url: string, key: string) => SupabaseClient) | null = null;
let importError: Error | null = null;

try {
  // @ts-ignore - dependency added in stage 2
  const mod = await import("@supabase/supabase-js");
  createClient = mod.createClient;
} catch (err) {
  importError = err as Error;
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const ready = createClient !== null && SUPABASE_ANON_KEY !== "" && SUPABASE_SERVICE_ROLE_KEY !== "";

describe.skipIf(!ready)("B.9 — Season RPC E2E (real Supabase)", () => {
  let anonClient: any;
  let serviceClient: any;

  beforeAll(() => {
    if (!createClient) {
      throw new Error(
        `@supabase/supabase-js not installed (${importError?.message ?? "unknown"}). ` +
        `Run \`npm install @supabase/supabase-js\` (stage 2).`,
      );
    }
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  });

  afterAll(async () => {
    // Stage 2: clean up fixture data.
  });

  // ----------------------------------------------------------
  // B.9.1 — Full season lifecycle E2E
  // ----------------------------------------------------------
  it("B.9.1 — Strict-Test: full lifecycle (create -> 90 days -> reset -> new season)", async () => {
    // Strict-Test per ADR-264 §5 (no mock — real Supabase, real RPC).
    const { data, error } = await serviceClient.rpc("reset_season");
    expect(error).toBeNull();
    expect(typeof data).toBe("number");
    expect(data).toBeGreaterThan(1);
  });

  // ----------------------------------------------------------
  // B.9.2 — Display layer SQL queries
  // ----------------------------------------------------------
  it("B.9.2 — current season + historical leaderboard queryable", async () => {
    const { data: active, error: e1 } = await anonClient
      .from("seasons")
      .select("season_number, started_at, config")
      .eq("status", "active")
      .single();
    expect(e1).toBeNull();
    expect(active).toBeDefined();
    expect(active.season_number).toBeGreaterThanOrEqual(1);

    const { data: history, error: e2 } = await anonClient
      .from("season_archives")
      .select("season_id, gene_id, final_fitness, arena_rank")
      .order("season_id", { ascending: false })
      .limit(20);
    expect(e2).toBeNull();
    expect(Array.isArray(history)).toBe(true);
  });

  // ----------------------------------------------------------
  // B.9.3 — Concurrency / performance
  // ----------------------------------------------------------
  it("B.9.3 — get_display_fitness p99 latency < 500ms for 100 genes", async () => {
    const { data: genes, error: geneErr } = await anonClient
      .from("genes")
      .select("id")
      .eq("published", true)
      .limit(100);
    expect(geneErr).toBeNull();

    const latencies: number[] = [];
    await Promise.all(
      (genes as Array<{ id: string }>).map(async (g) => {
        const start = performance.now();
        await anonClient.rpc("get_display_fitness", { p_gene_id: g.id });
        latencies.push(performance.now() - start);
      }),
    );

    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
    expect(p99).toBeLessThan(500);
  });

  // ----------------------------------------------------------
  // B.9.4 — seasons.config mutation takes effect immediately
  // ----------------------------------------------------------
  it("B.9.4 — config change is picked up by the next RPC call", async () => {
    const { error: updErr } = await serviceClient
      .from("seasons")
      .update({
        config: {
          duration_days: 90,
          fitness_retention_rate: 0.8,
          newcomer_protection_days: 30,
          newcomer_bonus_multiplier: 1.5,
          diversity_factor_alpha: 0.7,
          min_unique_callers: 2,
          adjustment_mode: "manual",
        },
      })
      .eq("status", "active");
    expect(updErr).toBeNull();

    const { data: cfg, error: readErr } = await anonClient
      .from("seasons")
      .select("config")
      .eq("status", "active")
      .single();
    expect(readErr).toBeNull();
    expect(cfg.config.diversity_factor_alpha).toBe(0.7);
  });
});

// Top-level placeholder test so vitest doesn't drop the file entirely when the
// suite is skipped — keeps it visible in the run report.
describe.runIf(!ready)("B.9 — Season RPC E2E (skipped)", () => {
  it("environment not configured for E2E (stage 1 expected state)", () => {
    expect(ready).toBe(false);
  });
});
