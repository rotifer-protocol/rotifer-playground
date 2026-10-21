-- Give get_arena_leaderboard a unique last sort key, so paging is stable.
--
-- The board is ordered by tier, domain, fitness_value DESC. Rows with equal
-- fitness had no defined order between calls, so reading it with LIMIT/OFFSET
-- (as `rotifer genome import` does to collect candidates) could return a row
-- on two pages and skip another. Measured on the fixture in
-- supabase/tests/arena_leaderboard_paging.sql: 30 rows read, 29 distinct.
-- A skipped row is a missed import candidate.
--
-- gene_id is unique per row here: the board has one row per logical gene, and
-- gene_id is that row's genes.id.
--
-- The function below is the 20260819190000 body with one change: `t.gene_id`
-- appended to the final ORDER BY. Signature, return columns, tiering, the
-- tier_rank window, LIMIT clamping and grants are unchanged (CREATE OR
-- REPLACE keeps the existing COMMENT and GRANTs).
--
-- Rollback target: the 20260819190000 body.

BEGIN;

CREATE OR REPLACE FUNCTION get_arena_leaderboard(
  p_domain TEXT DEFAULT NULL,
  p_limit  INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  tier                TEXT,
  tier_rank           BIGINT,
  gene_id             UUID,
  gene_name           TEXT,
  gene_version        TEXT,
  owner_username      TEXT,
  domain              TEXT,
  fidelity            TEXT,
  fitness_value       DOUBLE PRECISION,
  base_fitness        DOUBLE PRECISION,
  fidelity_discount   DOUBLE PRECISION,
  safety_score        DOUBLE PRECISION,
  evaluation_method   TEXT,
  evaluation_n        INTEGER,
  unique_callers      INTEGER,
  invalidation_reason TEXT,
  total_calls         BIGINT,
  last_evaluated      TIMESTAMPTZ,
  versions_on_board   BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_min_callers INTEGER := arena_min_unique_callers();
BEGIN
  p_limit  := LEAST(GREATEST(p_limit, 1), 200);
  p_offset := GREATEST(p_offset, 0);

  RETURN QUERY
  WITH rows AS (
    SELECT
      ae.gene_id, ae.domain AS row_domain, ae.fitness_value, ae.base_fitness,
      ae.fidelity_discount, ae.safety_score, ae.evaluation_method,
      ae.evaluation_n, ae.invalidated_at, ae.invalidation_reason,
      ae.total_calls, ae.last_evaluated,
      g.name, g.version, g.fidelity, g.owner_id,
      COALESCE(m.unique_callers, 0) AS unique_callers,
      g.created_at
    FROM arena_entries ae
    JOIN genes g ON g.id = ae.gene_id
    LEFT JOIN gene_contribution_metrics m ON m.gene_id = ae.gene_id
    WHERE g.published = true
      AND (p_domain IS NULL OR ae.domain = p_domain)
  ),
  -- One row per logical gene: newest still-valid version, else newest at all.
  picked AS (
    SELECT DISTINCT ON (owner_id, name) *,
           count(*) OVER (PARTITION BY owner_id, name) AS versions_on_board
      FROM rows
     ORDER BY owner_id, name,
              (invalidated_at IS NULL) DESC,   -- prefer a version still standing
              created_at DESC
  ),
  tiered AS (
    SELECT p.*,
      CASE
        WHEN p.invalidated_at IS NOT NULL THEN 'not_evaluated'
        WHEN p.evaluation_method IN ('sandbox', 'binding_runtime')
             AND p.unique_callers >= v_min_callers THEN 'verified'
        WHEN p.evaluation_method IN ('sandbox', 'binding_runtime') THEN 'under_evaluation'
        ELSE 'not_evaluated'
      END AS row_tier
    FROM picked p
  )
  SELECT
    t.row_tier,
    -- Rank only where a rank means something. not_evaluated has no order to
    -- report: sorting unmeasured numbers would hand them back the authority
    -- the tier just took away.
    CASE WHEN t.row_tier = 'not_evaluated' THEN NULL
         ELSE row_number() OVER (
                PARTITION BY t.row_tier, t.row_domain
                ORDER BY t.fitness_value DESC NULLS LAST)
    END AS tier_rank,
    t.gene_id, t.name, t.version, pr.username, t.row_domain, t.fidelity,
    t.fitness_value, t.base_fitness, t.fidelity_discount, t.safety_score,
    t.evaluation_method, t.evaluation_n, t.unique_callers, t.invalidation_reason,
    t.total_calls, t.last_evaluated, t.versions_on_board
  FROM tiered t
  JOIN profiles pr ON pr.id = t.owner_id
  ORDER BY
    CASE t.row_tier WHEN 'verified' THEN 0 WHEN 'under_evaluation' THEN 1 ELSE 2 END,
    t.row_domain,
    t.fitness_value DESC NULLS LAST,
    -- Unique tiebreak: without it, rows with equal fitness have no defined
    -- order between pages, and LIMIT/OFFSET paging can repeat or skip them.
    t.gene_id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

COMMIT;
