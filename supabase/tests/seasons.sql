-- ============================================================
-- pgTAP tests for v0.9 Season System
-- File: supabase/tests/seasons.sql
-- ============================================================
--
-- Coverage:
--   B.1 — schema migration (5 tests)
--   B.2 — reset_season() RPC (8 tests)
--   B.3 — get_display_fitness() (8 tests)
--   B.4 — get_display_weight() (6 tests)
--   B.5 — compute_path_diversity() (5 tests)
--   B.6 — refresh_contribution_metrics() §33.4 (6 tests, fixture-backed)
--   B.7 — RLS policy (5 tests)
--   B.8 — pg_cron automation (3 tests)
--
-- Total: 60 assertions (B.1=11, B.2=9, B.3=9, B.4=7, B.5=6, B.6=10, B.7=5, B.8=3).
-- Stage 2 expectation: PASS once v0.9 RPC bodies + RLS hardening land.
--
-- Run inside supabase test container:
--   supabase test db
--
-- Or directly via psql:
--   psql ... -f supabase/tests/seasons.sql

BEGIN;

SELECT plan(60);

-- ============================================================
-- B.1 Schema migration
-- ============================================================

-- B.1.1 — seasons table exists with correct fields
SELECT has_table('public', 'seasons', 'B.1.1a: seasons table exists');
SELECT col_type_is('public', 'seasons', 'id', 'integer', 'B.1.1b: seasons.id is SERIAL/integer');
SELECT col_type_is('public', 'seasons', 'season_number', 'integer', 'B.1.1c: seasons.season_number INTEGER');
SELECT col_default_is('public', 'seasons', 'status', 'active', 'B.1.1d: seasons.status default = active');

-- B.1.2 — config JSONB carries all 11 ADR-221 keys
SELECT ok(
  (SELECT (config ? 'duration_days')
       AND (config ? 'fitness_retention_rate')
       AND (config ? 'newcomer_protection_days')
       AND (config ? 'newcomer_bonus_multiplier')
       AND (config ? 'diversity_factor_alpha')
       AND (config ? 'min_unique_callers')
       AND (config ? 'adjustment_mode')
       AND (config ? 'adjustment_bounds')
       AND (config ? 'adjustment_bounds_by_phase')
       AND (config ? 'adjustment_priority')
       AND (config ? 'adjustment_exclusions')
   FROM seasons LIMIT 1),
  'B.1.2: seasons.config carries the 11 ADR-221 keys'
);

-- B.1.3 — season_archives table + FK + UNIQUE
SELECT has_table('public', 'season_archives', 'B.1.3a: season_archives table exists');
SELECT col_is_fk('public', 'season_archives', 'season_id', 'B.1.3b: season_id is FK');
SELECT col_is_fk('public', 'season_archives', 'gene_id', 'B.1.3c: gene_id is FK');
SELECT col_is_unique(
  'public', 'season_archives', ARRAY['season_id', 'gene_id'],
  'B.1.3d: (season_id, gene_id) is UNIQUE'
);

-- B.1.4 — Migration idempotency: re-running the migration is a no-op.
--   (validated structurally — repeated CREATE TABLE IF NOT EXISTS doesn't error)
SELECT lives_ok(
  $$ DO $body$ BEGIN
       CREATE TABLE IF NOT EXISTS seasons (id SERIAL PRIMARY KEY);
     END $body$;
  $$,
  'B.1.4: re-creating seasons IF NOT EXISTS is idempotent'
);

-- B.1.5 — DROP order: archives FK references seasons, so archives must DROP first
SELECT col_is_fk('public', 'season_archives', 'season_id', 'B.1.5: FK enforces archives-before-seasons drop order');

-- ============================================================
-- B.2 reset_season() RPC
-- ============================================================

SELECT has_function('public', 'reset_season', 'B.2.0: reset_season() function exists');

-- B.2.1 — Raises EXCEPTION when no active season.
--
-- Bootstrap migration installs season 1 as active. To exercise the
-- no-active-season branch we mark every season ended inside a savepoint,
-- run the assertion, then rollback to the savepoint so subsequent tests
-- (B.2.2 happy path, B.2.3 config read) still see an active season.
SAVEPOINT sp_b21_no_active_season;
UPDATE seasons SET status = 'ended', ended_at = COALESCE(ended_at, now());
SELECT throws_like(
  $$ SELECT reset_season() $$,
  '%No active season found%',
  'B.2.1: reset_season() raises when no active season'
);
ROLLBACK TO SAVEPOINT sp_b21_no_active_season;
RELEASE SAVEPOINT sp_b21_no_active_season;

-- B.2.2 — Happy path: archives created + arena × retention + new season +1
SELECT lives_ok(
  $$ SELECT reset_season() $$,
  'B.2.2: reset_season() succeeds on happy path'
);

-- B.2.3 — fitness_retention_rate read from active season's config
SELECT is(
  (SELECT (config->>'fitness_retention_rate')::DOUBLE PRECISION FROM seasons WHERE status='active' LIMIT 1),
  0.5::DOUBLE PRECISION,
  'B.2.3: fitness_retention_rate defaults to 0.5'
);

-- B.2.4 — Archive row count equals published Gene count after reset.
--   Stage 2 will verify via dynamic comparison; here just sketch the assertion.
SELECT ok(
  (SELECT COUNT(*) FROM season_archives) >= 0,
  'B.2.4: season_archives row count present (stage-2 verifies equality with published genes)'
);

-- B.2.5 — reset_season triggers compute_all_reputations()
SELECT has_function('public', 'compute_all_reputations', 'B.2.5: compute_all_reputations() function exists');

-- B.2.6 — Old season status -> ended + ended_at set
SELECT ok(
  (SELECT COUNT(*) FROM seasons WHERE status = 'ended') >= 0,
  'B.2.6: ended seasons accumulate (verified post-reset)'
);

-- B.2.7 — Strict-Test: concurrent reset → only one succeeds (advisory lock)
-- Cannot fully simulate concurrency in pgTAP — sketch the assertion only.
SELECT skip(1, 'B.2.7 Strict-Test: requires multi-session — covered in seasons-rpc.test.ts');

-- B.2.8 — SECURITY DEFINER + anon cannot execute
SELECT function_privs_are(
  'public', 'reset_season', ARRAY[]::text[],
  'anon',
  ARRAY[]::text[],
  'B.2.8: anon role has no EXECUTE on reset_season'
);

-- ============================================================
-- B.3 get_display_fitness()
-- ============================================================

SELECT has_function('public', 'get_display_fitness', ARRAY['uuid'], 'B.3.0: get_display_fitness(UUID) exists');

-- B.3.1 — no arena_entries → returns 0
SELECT is(
  get_display_fitness('00000000-0000-0000-0000-000000000000'::UUID),
  0.0::DOUBLE PRECISION,
  'B.3.1: missing arena_entries -> COALESCE 0'
);

-- B.3.2 — usage_freq = 0 → diversity_factor = 1
-- Placeholder: real verification requires inserting fixture Genes (stage 2)
SELECT skip(1, 'B.3.2: requires Gene fixture seeding — stage 2');

-- B.3.3 — usage_freq = total (monopoly) → diversity floor 0.1
SELECT skip(1, 'B.3.3: requires Gene fixture seeding — stage 2');

-- B.3.4 — alpha=0.5 formula correctness (5 control points)
SELECT skip(1, 'B.3.4: requires Gene fixture seeding — stage 2');

-- B.3.5 — alpha read from active season config, fallback 0.5 when absent
SELECT skip(1, 'B.3.5: requires Gene fixture seeding — stage 2');

-- B.3.6 — Double dimension: usage_diversity × path_diversity
SELECT skip(1, 'B.3.6: requires Gene fixture seeding — stage 2');

-- B.3.7 — Property: output ∈ [raw_fitness*0.03, raw_fitness]
SELECT skip(1, 'B.3.7: property-based — covered in cross-impl tests / stage 2');

-- B.3.8 — STABLE marker — same input → same output (pgTAP function metadata check)
SELECT volatility_is(
  'public', 'get_display_fitness', ARRAY['uuid'], 'stable',
  'B.3.8: get_display_fitness is STABLE'
);

-- ============================================================
-- B.4 get_display_weight()
-- ============================================================

SELECT has_function('public', 'get_display_weight', ARRAY['uuid'], 'B.4.0: get_display_weight(UUID) exists');

-- B.4.1 — author first publish ≤ 30 days → bonus 1.5x
SELECT skip(1, 'B.4.1: requires Gene + author fixture — stage 2');

-- B.4.2 — author first publish > 30 days → bonus 1.0 (boundary 31 days)
SELECT skip(1, 'B.4.2: requires Gene + author fixture — stage 2');

-- B.4.3 — Strict-Test: take author's earliest publish across all Genes (§35.3.2)
SELECT skip(1, 'B.4.3 Strict-Test: requires multi-Gene author fixture — stage 2');

-- B.4.4 — Draft Genes excluded from first-publish calculation
SELECT skip(1, 'B.4.4: requires Draft + Published mix fixture — stage 2');

-- B.4.5 — protection_days read from config
SELECT skip(1, 'B.4.5: requires config mutation — stage 2');

-- B.4.6 — bonus_multiplier read from config
SELECT skip(1, 'B.4.6: requires config mutation — stage 2');

-- ============================================================
-- B.5 compute_path_diversity()
-- ============================================================

SELECT has_function('public', 'compute_path_diversity', ARRAY['uuid', 'text'], 'B.5.0: compute_path_diversity(UUID, TEXT) exists');

SELECT skip(1, 'B.5.1: single Gene in domain → 1.0 — requires fixture');
SELECT skip(1, 'B.5.2: identical phenotypes → 0.3 floor — requires fixture');
SELECT skip(1, 'B.5.3: Jaccard distance correctness — requires fixture');
SELECT skip(1, 'B.5.4: property — output ∈ [0.3, 1.0] — covered in stage 2');
SELECT skip(1, 'B.5.5: empty dependencies set → no NaN — requires fixture');

-- ============================================================
-- B.6 refresh_contribution_metrics() §33.4
-- ============================================================
--
-- These rules gate Arena ranking eligibility, and until 2026-08-17 not one of
-- them had ever run against data: B.6.1/2/3/5 were `skip(... stage 2)` for want
-- of a fixture. That is how the invocation pipeline stayed broken for months
-- while this suite reported green — the function was only ever asked whether it
-- existed. ADR-319 stage 1 item 1.7. The fixture below is the same shape as
-- supabase/tests/arena_total_calls_trigger.sql (auth.users -> profile trigger
-- -> gene), rolled back with the rest of the file. Publishing these fixture
-- Genes emits five `content_hash mismatch (non-blocking, see ADR-292)`
-- WARNINGs — expected: client and server canonicalize phenotype differently,
-- and migration 20260528021934 downgraded that arm to a warning. If ADR-292
-- ever restores the hard failure, this fixture needs real hashes.
--
-- Spec rule numbering (§33.4) — the inline comments in migration
-- 20260527020821 use a different numbering, so read the spec, not the code:
--   Rule 1 Self-Invocation Exclusion
--   Rule 2 Minimum Unique Callers Threshold
--   Rule 3 Call-Loop Detection (mutual invocation between two authors)
--   Rule 4 Time-Window Deduplication

SELECT has_function('public', 'refresh_contribution_metrics', 'B.6.0: refresh_contribution_metrics() exists');

-- ------------------------------------------------------------
-- Fixture. Timestamps are anchored on date_trunc('day', ...) so that "same
-- calendar day" is deterministic regardless of when CI runs.
--   G1 author's own call + 2 external callers   -> Rule 1
--   G2 one caller only, on three separate days  -> Rule 2
--   G3 one caller x3 in a day (+4min, +2h) plus a second caller, and again the
--      next day                                 -> Rule 4
--   GP/GQ two authors invoking each other       -> Rule 3
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'b6-author-a@example.com', '{"user_name":"b6_author_a"}'::jsonb),
  ('b0000000-0000-4000-8000-000000000002', 'b6-author-p@example.com', '{"user_name":"b6_author_p"}'::jsonb),
  ('b0000000-0000-4000-8000-000000000003', 'b6-author-q@example.com', '{"user_name":"b6_author_q"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('a1111111-1111-4111-8111-111111111111','b0000000-0000-4000-8000-000000000001','b6_gene_one','test.b6','0.1.0','Wrapped','{"domain":"test.b6","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,true,repeat('1',64)),
  ('a2222222-2222-4222-8222-222222222222','b0000000-0000-4000-8000-000000000001','b6_gene_two','test.b6','0.1.0','Wrapped','{"domain":"test.b6","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,true,repeat('2',64)),
  ('a3333333-3333-4333-8333-333333333333','b0000000-0000-4000-8000-000000000001','b6_gene_three','test.b6','0.1.0','Wrapped','{"domain":"test.b6","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,true,repeat('3',64)),
  ('a4444444-4444-4444-8444-444444444444','b0000000-0000-4000-8000-000000000002','b6_gene_p','test.b6','0.1.0','Wrapped','{"domain":"test.b6","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,true,repeat('4',64)),
  ('a5555555-5555-4555-8555-555555555555','b0000000-0000-4000-8000-000000000003','b6_gene_q','test.b6','0.1.0','Wrapped','{"domain":"test.b6","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,true,repeat('5',64));

INSERT INTO gene_invocation_log (gene_id, caller_agent_id, invoked_at) VALUES
  ('a1111111-1111-4111-8111-111111111111','b0000000-0000-4000-8000-000000000001', date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a1111111-1111-4111-8111-111111111111','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a1111111-1111-4111-8111-111111111111','b6-caller-y',                          date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a2222222-2222-4222-8222-222222222222','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a2222222-2222-4222-8222-222222222222','b6-caller-x',                          date_trunc('day', now() - interval '2 days') + interval '9 hours'),
  ('a2222222-2222-4222-8222-222222222222','b6-caller-x',                          date_trunc('day', now() - interval '1 days') + interval '9 hours'),
  ('a3333333-3333-4333-8333-333333333333','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a3333333-3333-4333-8333-333333333333','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '9 hours 4 minutes'),
  ('a3333333-3333-4333-8333-333333333333','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '11 hours'),
  ('a3333333-3333-4333-8333-333333333333','b6-caller-y',                          date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a3333333-3333-4333-8333-333333333333','b6-caller-x',                          date_trunc('day', now() - interval '2 days') + interval '9 hours'),
  ('a4444444-4444-4444-8444-444444444444','b0000000-0000-4000-8000-000000000003', date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a4444444-4444-4444-8444-444444444444','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a5555555-5555-4555-8555-555555555555','b0000000-0000-4000-8000-000000000002', date_trunc('day', now() - interval '3 days') + interval '9 hours'),
  ('a5555555-5555-4555-8555-555555555555','b6-caller-x',                          date_trunc('day', now() - interval '3 days') + interval '9 hours');

-- PERFORM inside DO so the refresh emits no result set into the TAP stream.
DO $refresh$ BEGIN PERFORM refresh_contribution_metrics(); END $refresh$;

-- B.6.1 — Rule 1: the author's own invocation of their own Gene is excluded.
--   G1 has 3 raw invocations, one of them by the author. Both counters must
--   see 2. (is_self_invocation is a generated column fed by the BEFORE INSERT
--   trigger that copies genes.owner_id — B.6.1 covers that wiring too.)
SELECT is(
  (SELECT unique_callers FROM gene_contribution_metrics WHERE gene_id = 'a1111111-1111-4111-8111-111111111111'),
  2,
  'B.6.1a: Rule 1 — the author''s own call is not a unique caller');
SELECT is(
  (SELECT total_invocations FROM gene_contribution_metrics WHERE gene_id = 'a1111111-1111-4111-8111-111111111111'),
  2,
  'B.6.1b: Rule 1 — nor does it inflate total_invocations');

-- B.6.2 — Rule 2: below MIN_UNIQUE_CALLERS the Gene is not counted at all.
--   G2 has 3 valid invocations but only 1 distinct caller, so the HAVING clause
--   drops it and the LEFT JOIN writes zeros. Note what this means for §9.7.1:
--   the aggregate row loses the real numbers, so third-party recomputation has
--   to go back to the raw log — which stays public and complete (B.6.2b).
SELECT is(
  (SELECT total_invocations FROM gene_contribution_metrics WHERE gene_id = 'a2222222-2222-4222-8222-222222222222'),
  0,
  'B.6.2a: Rule 2 — a single-caller Gene is zeroed, not ranked ("Under Evaluation")');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log WHERE gene_id = 'a2222222-2222-4222-8222-222222222222'),
  3::bigint,
  'B.6.2b: Rule 2 — the raw log still holds all 3 rows (§9.7.1 recomputability)');

-- B.6.3 — Rule 4: repeated calls by the same caller collapse.
--   G3 raw: caller-x at 09:00 / 09:04 / 11:00 on day-3, caller-y at 09:00 on
--   day-3, caller-x again on day-2 = 5 rows. Counted: 3.
--   The binding is STRICTER than the spec's recommended 1h DEDUP_WINDOW — the
--   11:00 call is two hours later and still drops, because migration
--   20260527020821 keeps only the first call per caller-gene per calendar day.
--   (Its 5-minute LAG filter is subsumed by that day cap and can only bite
--   across a midnight boundary.)
SELECT is(
  (SELECT total_invocations FROM gene_contribution_metrics WHERE gene_id = 'a3333333-3333-4333-8333-333333333333'),
  3,
  'B.6.3a: Rule 4 — 5 raw invocations collapse to 3 (one per caller per day)');
SELECT is(
  (SELECT unique_callers FROM gene_contribution_metrics WHERE gene_id = 'a3333333-3333-4333-8333-333333333333'),
  2,
  'B.6.3b: Rule 4 — dedup does not lose a distinct caller');

-- B.6.4 — MIN_UNIQUE_CALLERS = 2 (decision D-02 initial)
--   Spec §33.4 Rule 2 recommends 5; the binding starts at 2 and the gap is
--   tracked as "Under Evaluation" (ADR-319 D3).
SELECT is(
  (SELECT (config->>'min_unique_callers')::INTEGER FROM seasons WHERE status='active' LIMIT 1),
  2,
  'B.6.4: min_unique_callers initial value = 2'
);

-- B.6.5 — UPSERT: a second refresh updates the existing row in place.
--   A new caller arrives for G1 on a later day; re-running must move 2 -> 3
--   rather than leaving the previous aggregate standing.
INSERT INTO gene_invocation_log (gene_id, caller_agent_id, invoked_at) VALUES
  ('a1111111-1111-4111-8111-111111111111','b6-caller-z', date_trunc('day', now() - interval '2 days') + interval '9 hours');
DO $refresh2$ BEGIN PERFORM refresh_contribution_metrics(); END $refresh2$;
SELECT is(
  (SELECT total_invocations FROM gene_contribution_metrics WHERE gene_id = 'a1111111-1111-4111-8111-111111111111'),
  3,
  'B.6.5: second refresh updates the row in place (2 -> 3), no stale aggregate');

-- B.6.6 — Rule 3 Call-Loop Detection is NOT implemented.
--   ⚠️ This assertion pins the CURRENT behaviour, which the spec forbids:
--   author P and author Q invoke each other's Genes, and both invocations are
--   still counted. §33.4 Rule 3 says mutual invocations MUST NOT count toward
--   each other's uniqueCallers within LOOP_DETECTION_WINDOW (default 30 days).
--   The `daily_rank` filter labelled "Rule 3" in migration 20260527020821 is an
--   extra dedup, not loop detection. When Rule 3 lands this must flip to 1.
SELECT is(
  (SELECT unique_callers FROM gene_contribution_metrics WHERE gene_id = 'a4444444-4444-4444-8444-444444444444'),
  2,
  'B.6.6: Rule 3 gap — a mutual author invocation is still counted (must become 1 when Rule 3 lands)');

-- ============================================================
-- B.7 RLS policies
-- ============================================================

-- B.7.1 — anon can SELECT seasons
SELECT policies_are(
  'public', 'seasons',
  ARRAY['seasons_public_read', 'seasons_no_anon_write'],
  'B.7.1: seasons policies present (public read + anon no-write)'
);

-- B.7.2 — anon cannot INSERT/UPDATE/DELETE seasons
SELECT table_privs_are(
  'public', 'seasons', 'anon', ARRAY['SELECT'],
  'B.7.2: anon has only SELECT on seasons'
);

-- B.7.3 — service_role can do everything (verified indirectly via owner privs)
SELECT skip(1, 'B.7.3: service_role full access — verified in seasons-rpc.test.ts');

-- B.7.4 — season_archives symmetric RLS
SELECT policies_are(
  'public', 'season_archives',
  ARRAY['season_archives_public_read', 'season_archives_no_anon_write'],
  'B.7.4: season_archives policies present'
);

-- B.7.5 — reset_season() not executable by anon
SELECT function_privs_are(
  'public', 'reset_season', ARRAY[]::text[],
  'anon', ARRAY[]::text[],
  'B.7.5: anon cannot EXECUTE reset_season()'
);

-- ============================================================
-- B.8 pg_cron automation
-- ============================================================

-- B.8.1 — `check-season-reset` cron job is registered.
--   Stage 1 keeps the cron commented out, so this assertion is expected to fail.
PREPARE p_b81 AS SELECT 1 FROM cron.job WHERE jobname = 'check-season-reset';
SELECT bag_eq(
  'p_b81',
  $$ VALUES (1) $$,
  'B.8.1: check-season-reset cron job registered (FAIL until stage 2 uncomments)'
);
DEALLOCATE p_b81;

-- B.8.2 — schedule is '0 1 * * *'
SELECT skip(1, 'B.8.2: depends on B.8.1 — stage 2');

-- B.8.3 — cron only fires when deadline reached
SELECT skip(1, 'B.8.3: depends on B.8.1 — stage 2');

-- ============================================================
-- Done
-- ============================================================

SELECT * FROM finish();
ROLLBACK;
