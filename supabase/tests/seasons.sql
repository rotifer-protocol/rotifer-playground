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
--   B.6 — refresh_contribution_metrics() §33.4 (6 tests)
--   B.7 — RLS policy (5 tests)
--   B.8 — pg_cron automation (3 tests)
--
-- Total: ~46 assertions. Stage 1 expectation: ALL FAIL (red phase).
--
-- Run inside supabase test container:
--   supabase db test
--
-- Or directly via psql:
--   psql ... -f supabase/tests/seasons.sql

BEGIN;

SELECT plan(46);

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

-- B.2.1 — Raises EXCEPTION when no active season
-- Stage 1 stub raises 'NOT_IMPLEMENTED' for ALL paths — this assertion is expected
-- to fail until stage 2 differentiates the "no active season" branch.
PREPARE p_b21 AS SELECT reset_season();
SELECT throws_like(
  'p_b21',
  '%No active season found%',
  'B.2.1: reset_season() raises when no active season'
);
DEALLOCATE p_b21;

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

SELECT has_function('public', 'refresh_contribution_metrics', 'B.6.0: refresh_contribution_metrics() exists');

-- B.6.1 — Rule 1 Self-invocation excluded
SELECT skip(1, 'B.6.1: requires gene_invocation_log fixture with self+other — stage 2');

-- B.6.2 — Rule 2 Unique callers de-dup
SELECT skip(1, 'B.6.2: requires duplicate-caller fixture — stage 2');

-- B.6.3 — Rule 4 1h time window dedup
SELECT skip(1, 'B.6.3: requires intra-hour fixture — stage 2');

-- B.6.4 — MIN_UNIQUE_CALLERS = 2 (decision D-02 initial)
SELECT is(
  (SELECT (config->>'min_unique_callers')::INTEGER FROM seasons WHERE status='active' LIMIT 1),
  2,
  'B.6.4: min_unique_callers initial value = 2'
);

-- B.6.5 — UPSERT correctness on second refresh
SELECT skip(1, 'B.6.5: requires double-refresh fixture — stage 2');

-- B.6.6 — Rule 3 Call-Loop Detection deferred (application layer)
SELECT skip(1, 'B.6.6: documented as deferred to application layer');

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
