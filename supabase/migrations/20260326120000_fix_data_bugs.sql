-- ============================================================
-- Migration: Fix 4 Data Bugs
-- Rotifer Protocol v0.7.7
--
-- Bug 1: genes.downloads never cascades to reputation recomputation
--   Root cause: trg_gene_published_reputation only fires on INSERT
--   or UPDATE OF published — not on UPDATE OF downloads.
--   Fix: add trigger on UPDATE OF downloads → compute_gene_reputation.
--
-- Bug 2: get_reputation_leaderboard omits community_bonus
--   Root cause: RETURNS TABLE and SELECT lack the column.
--   Fix: add community_bonus to both.
--
-- Bug 3: gene_reputation.usage_score always 0
--   Direct consequence of Bug 1. Resolves when downloads
--   cascade triggers reputation recomputation.
--
-- Bug 4: stability_score always 0.01
--   Root cause: total_calls = 1 for all genes, formula 1/100 = 0.01.
--   Stability query was also missing ORDER BY / LIMIT 1.
--   Fix: use log-scale formula (matches usage_score approach),
--   aggregate total_calls across all arena evaluations.
--
-- Trigger chain after fix (no loops — verified):
--
--   track_download(gene_id)
--     → INSERT downloads
--       → [trg] genes.downloads++                 (existing)
--         → [trg NEW] compute_gene_reputation      (this migration)
--           → INSERT gene_reputation
--             → [trg] compute_developer_reputation  (existing)
--
--   Loop prevention:
--     - fn_downloads_reputation fires on UPDATE OF downloads
--     - compute_gene_reputation updates genes.reputation_score (not downloads)
--     - Therefore no re-trigger
-- ============================================================

BEGIN;

-- =====================
-- Bug 2 FIX: Add community_bonus to get_reputation_leaderboard
-- Must DROP first because RETURNS TABLE signature changed.
-- =====================

DROP FUNCTION IF EXISTS get_reputation_leaderboard(INTEGER);

CREATE OR REPLACE FUNCTION get_reputation_leaderboard(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
  user_id UUID,
  username TEXT,
  avatar_url TEXT,
  score DOUBLE PRECISION,
  genes_published INTEGER,
  total_downloads BIGINT,
  arena_wins INTEGER,
  community_bonus DOUBLE PRECISION
) AS $$
BEGIN
  p_limit := LEAST(p_limit, 100);

  RETURN QUERY
  SELECT
    dr.user_id,
    p.username,
    p.avatar_url,
    dr.score,
    dr.genes_published,
    dr.total_downloads,
    dr.arena_wins,
    dr.community_bonus
  FROM developer_reputation dr
  JOIN profiles p ON dr.user_id = p.id
  ORDER BY dr.score DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = 'public';

-- =====================
-- Bug 1/3 FIX: Trigger downloads change → reputation recompute
-- =====================

CREATE OR REPLACE FUNCTION fn_downloads_reputation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.downloads IS DISTINCT FROM OLD.downloads THEN
    PERFORM compute_gene_reputation(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_downloads_reputation ON genes;
CREATE TRIGGER trg_downloads_reputation
  AFTER UPDATE OF downloads ON genes
  FOR EACH ROW EXECUTE FUNCTION fn_downloads_reputation();

-- =====================
-- Bug 4 FIX: Improved compute_gene_reputation
--
-- Changes from previous version:
--   1. stability_score default 0.0 (was 1.0 — penalized genes WITH arena data)
--   2. Aggregate total_calls across ALL arena evaluations (was single row, no ORDER BY)
--   3. Log-scale formula for stability: ln(calls+1)/ln(101)
--      - 1 call  → 0.15 (was 0.01)
--      - 10 calls → 0.52
--      - 100 calls → 1.0
-- =====================

CREATE OR REPLACE FUNCTION compute_gene_reputation(p_gene_id UUID)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_arena_score DOUBLE PRECISION := 0.0;
  v_usage_score DOUBLE PRECISION := 0.0;
  v_stability_score DOUBLE PRECISION := 0.0;
  v_fitness DOUBLE PRECISION;
  v_downloads BIGINT;
  v_total_calls BIGINT;
  v_reputation DOUBLE PRECISION;
BEGIN
  SELECT fitness_value INTO v_fitness
  FROM arena_entries
  WHERE gene_id = p_gene_id
  ORDER BY last_evaluated DESC
  LIMIT 1;

  IF v_fitness IS NOT NULL THEN
    v_arena_score := v_fitness;
  END IF;

  SELECT downloads INTO v_downloads
  FROM genes
  WHERE id = p_gene_id;

  IF v_downloads IS NOT NULL AND v_downloads > 0 THEN
    v_usage_score := LEAST(ln(v_downloads::DOUBLE PRECISION + 1) / ln(1000.0), 1.0);
  END IF;

  SELECT COALESCE(SUM(total_calls), 0) INTO v_total_calls
  FROM arena_entries
  WHERE gene_id = p_gene_id;

  IF v_total_calls > 0 THEN
    v_stability_score := LEAST(ln(v_total_calls::DOUBLE PRECISION + 1) / ln(101.0), 1.0);
  END IF;

  v_reputation := 0.5 * v_arena_score + 0.3 * v_usage_score + 0.2 * v_stability_score;

  INSERT INTO gene_reputation (gene_id, score, arena_score, usage_score, stability_score, epoch)
  VALUES (p_gene_id, v_reputation, v_arena_score, v_usage_score, v_stability_score,
          (SELECT COALESCE(MAX(epoch), 0) + 1 FROM gene_reputation WHERE gene_id = p_gene_id));

  UPDATE genes SET reputation_score = v_reputation WHERE id = p_gene_id;

  RETURN v_reputation;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

-- =====================
-- Recompute all reputations with fixed formulas
-- Order: gene_reputation → developer_reputation
-- =====================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (owner_id, name) id
    FROM genes
    WHERE published = true
    ORDER BY owner_id, name, created_at DESC
  LOOP
    PERFORM compute_gene_reputation(r.id);
  END LOOP;
END;
$$;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_id FROM genes WHERE published = true
  LOOP
    PERFORM compute_developer_reputation(r.owner_id);
  END LOOP;
END;
$$;

COMMIT;
