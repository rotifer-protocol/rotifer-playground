-- ============================================================
-- v0.9: Season System — seasons + season_archives + RPC stubs
-- Spec: §24.3 / §24.4 / §33.4 / §35.3.2
-- Plan: protocol-v0.9-plan.md §3.2
-- ADR-221 thermostat model, ADR-260 C3 carr support deferred
-- ============================================================
--
-- This migration sets up the **schema** and **RPC signatures** required by
-- v0.9 stage 1. Function bodies intentionally `RAISE EXCEPTION
-- 'NOT_IMPLEMENTED — v0.9 stage 1'` so the pgTAP suite in
-- `supabase/tests/seasons.sql` stays red until stage 2 plugs the real logic
-- in (TDD red phase).
--
-- Stage 2 will replace each stub body with the canonical SQL from plan §3.2.
-- DO NOT inline the real logic here yet — it must arrive together with the
-- corresponding tests turning green.

-- ------------------------------------------------------------
-- 0. pgTAP — required by supabase/tests/seasons.sql
-- ------------------------------------------------------------

-- Decision D-04 (2026-05-16): install pgTAP via migration rather than via
-- Supabase dashboard. Idempotent and visible in source control.
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- ------------------------------------------------------------
-- 1. `seasons` table
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  config JSONB NOT NULL DEFAULT '{
    "duration_days": 90,
    "fitness_retention_rate": 0.5,
    "newcomer_protection_days": 30,
    "newcomer_bonus_multiplier": 1.5,
    "diversity_factor_alpha": 0.5,
    "min_unique_callers": 2,
    "adjustment_mode": "manual",
    "adjustment_bounds": {
      "duration_days": [30, 365],
      "fitness_retention_rate": [0.3, 0.8],
      "diversity_factor_alpha": [0.1, 0.9],
      "newcomer_protection_days": [14, 90],
      "newcomer_bonus_multiplier": [1.0, 3.0]
    },
    "adjustment_bounds_by_phase": {
      "pre_emergent":   {"duration_days": [30, 180],  "diversity_factor_alpha": [0.3, 0.9]},
      "weak_emergent":  {"duration_days": [60, 365],  "diversity_factor_alpha": [0.1, 0.7]},
      "strong_emergent":{"duration_days": [90, 365],  "diversity_factor_alpha": [0.1, 0.5]},
      "meta_emergent":  {"duration_days": [90, 365],  "diversity_factor_alpha": [0.05, 0.4]}
    },
    "adjustment_priority": ["diversity_factor_alpha", "duration_days", "fitness_retention_rate", "newcomer_protection_days"],
    "adjustment_exclusions": [
      ["diversity_factor_alpha", "duration_days"],
      ["fitness_retention_rate", "duration_days"]
    ]
  }'::jsonb,
  CONSTRAINT seasons_status_check CHECK (status IN ('active', 'ending', 'ended'))
);

CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status) WHERE status = 'active';

-- ------------------------------------------------------------
-- 2. `season_archives` table
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS season_archives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  gene_id UUID NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
  final_fitness DOUBLE PRECISION NOT NULL,
  final_reputation DOUBLE PRECISION NOT NULL,
  arena_rank INTEGER,
  arena_wins INTEGER DEFAULT 0,
  arena_losses INTEGER DEFAULT 0,
  domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT season_archives_unique_per_season UNIQUE (season_id, gene_id)
);

CREATE INDEX IF NOT EXISTS idx_season_archives_season ON season_archives(season_id);
CREATE INDEX IF NOT EXISTS idx_season_archives_gene ON season_archives(gene_id);

-- ------------------------------------------------------------
-- 3. RLS — anon read, service_role write
-- ------------------------------------------------------------

ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_archives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "seasons_public_read" ON seasons;
CREATE POLICY "seasons_public_read"
  ON seasons FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "seasons_no_anon_write" ON seasons;
CREATE POLICY "seasons_no_anon_write"
  ON seasons FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS "season_archives_public_read" ON season_archives;
CREATE POLICY "season_archives_public_read"
  ON season_archives FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "season_archives_no_anon_write" ON season_archives;
CREATE POLICY "season_archives_no_anon_write"
  ON season_archives FOR INSERT
  WITH CHECK (false);

-- ------------------------------------------------------------
-- 4. RPC stubs — bodies stay `NOT_IMPLEMENTED` until stage 2.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION reset_season()
RETURNS INTEGER AS $$
BEGIN
  RAISE EXCEPTION 'NOT_IMPLEMENTED — v0.9 stage 1 (reset_season). '
                  'Stage 2 will plug plan §3.2 logic in.';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION reset_season() FROM anon;
REVOKE EXECUTE ON FUNCTION reset_season() FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_season() TO service_role;


CREATE OR REPLACE FUNCTION get_display_fitness(p_gene_id UUID)
RETURNS DOUBLE PRECISION AS $$
BEGIN
  RAISE EXCEPTION 'NOT_IMPLEMENTED — v0.9 stage 1 (get_display_fitness). '
                  'Stage 2 will plug double-dimension diversity logic in.';
END;
$$ LANGUAGE plpgsql STABLE SET search_path = 'public';


CREATE OR REPLACE FUNCTION get_display_weight(p_gene_id UUID)
RETURNS DOUBLE PRECISION AS $$
BEGIN
  RAISE EXCEPTION 'NOT_IMPLEMENTED — v0.9 stage 1 (get_display_weight). '
                  'Stage 2 will plug §35.3.2 author-based bonus in.';
END;
$$ LANGUAGE plpgsql STABLE SET search_path = 'public';


CREATE OR REPLACE FUNCTION compute_path_diversity(p_gene_id UUID, p_domain TEXT)
RETURNS DOUBLE PRECISION AS $$
BEGIN
  RAISE EXCEPTION 'NOT_IMPLEMENTED — v0.9 stage 1 (compute_path_diversity). '
                  'Stage 2 will plug Jaccard-distance logic (Ramanujan R1) in.';
END;
$$ LANGUAGE plpgsql STABLE SET search_path = 'public';


-- ------------------------------------------------------------
-- 5. pg_cron registration — kept commented to avoid production trigger
-- ------------------------------------------------------------
--
-- Stage 2 will uncomment the following block once `reset_season()` is
-- promoted from stub to implementation:
--
-- SELECT cron.schedule(
--   'check-season-reset',
--   '0 1 * * *',
--   $$
--     UPDATE seasons SET status = 'ending'
--     WHERE status = 'active'
--       AND started_at + (config->>'duration_days')::INTEGER * INTERVAL '1 day' <= now();
--     SELECT reset_season() WHERE EXISTS (SELECT 1 FROM seasons WHERE status = 'ending');
--   $$
-- );
--
-- The stub still appears in pgTAP test B.8.1 — it is expected to fail (cron
-- job not registered yet) until stage 2 uncomments this block.

-- ------------------------------------------------------------
-- 6. Bootstrap row — ensure season 1 exists for tests that need an active season
-- ------------------------------------------------------------

INSERT INTO seasons (season_number, status)
VALUES (1, 'active')
ON CONFLICT (season_number) DO NOTHING;
