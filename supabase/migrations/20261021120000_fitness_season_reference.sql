-- ============================================================
-- ADR-318 D2 / v0.9.3 #6: the F(g) reference scale is the season median
--
-- F(g)'s efficiency terms are φ = 1/(1 + L/L_ref) and ψ = 1/(1 + Cost/Cost_ref).
-- Until now L_ref and Cost_ref were fixed constants in the CLI (1000 ms and
-- 10000 fuel), which ADR-318 recorded as guesses and which make F(g) carry a
-- dimension and depend on whoever chose the numbers. D2 defines them as the
-- median, in the current season, over Genes of the same domain and fidelity —
-- a relative scale, so φ(1) = ψ(1) = 1/2 for a Gene exactly as fast and as
-- cheap as its peers.
--
-- The measurements already exist: every CLI sandbox evaluation writes its runs
-- to arena_evaluation_runs. get_fitness_reference() turns them into the two
-- medians at read time. Nothing is materialised, so there is no schedule to
-- keep and no stale snapshot; reproducibility comes from each Arena row
-- recording the reference it was computed with (three columns below).
--
-- The population, per (domain, fidelity), current active season only:
--   * published Genes only — so every caller gets the same answer, whatever
--     unpublished rows RLS lets them see;
--   * runs recorded by the Gene's own owner (evaluator = owner_id), so a third
--     party cannot write runs that move someone else's reference;
--   * one vote per Gene: its latest submission this season, averaged over the
--     runs that succeeded in the sandbox; a Gene whose latest submission has no
--     successful run does not count (a crash records 0 ms / 0 fuel, which is
--     not what a working Gene costs);
--   * Genes whose Arena entry is invalidated do not count;
--   * fewer than min_genes Genes (season config fitness_reference_min_genes,
--     default 5, a provisional [N]) → no row, and the CLI falls back to its
--     constants. A median that is not positive → no row as well.
--
-- Known limitation, not addressed here: arena_evaluation_runs accepts inserts
-- from any signed-in caller (WITH CHECK (true)) and its numbers are reported by
-- the client. Restricting the population to owner runs limits who can move a
-- reference, not whether the numbers are true. Changing that table's RLS needs
-- a security review first.
--
-- Additive per ADR-295: one function, three nullable columns, one CHECK on the
-- new columns. Nothing existing is altered or removed.
-- ============================================================

CREATE OR REPLACE FUNCTION get_fitness_reference(p_domain TEXT, p_fidelity TEXT)
RETURNS TABLE (
  l_ref_ms      DOUBLE PRECISION,
  cost_ref      DOUBLE PRECISION,
  sample_genes  INTEGER,
  season_number INTEGER
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH season AS (
    SELECT s.season_number,
           s.started_at,
           COALESCE((s.config->>'fitness_reference_min_genes')::INTEGER, 5) AS min_genes
    FROM seasons s
    WHERE s.status = 'active'
    ORDER BY s.season_number DESC
    LIMIT 1
  ),
  per_submission AS (
    SELECT r.gene_id,
           r.submission_id,
           max(r.evaluated_at)                                   AS evaluated_at,
           count(*) FILTER (WHERE r.sandbox_success)             AS succeeded,
           avg(r.latency_ms)    FILTER (WHERE r.sandbox_success) AS avg_latency_ms,
           avg(r.resource_cost) FILTER (WHERE r.sandbox_success) AS avg_cost
    FROM arena_evaluation_runs r
    JOIN genes g ON g.id = r.gene_id
    CROSS JOIN season
    WHERE g.domain = p_domain
      AND g.fidelity = p_fidelity
      AND g.published = true
      AND r.evaluator = g.owner_id::TEXT
      AND r.evaluated_at >= season.started_at
    GROUP BY r.gene_id, r.submission_id
  ),
  latest AS (
    SELECT DISTINCT ON (ps.gene_id) ps.gene_id, ps.succeeded, ps.avg_latency_ms, ps.avg_cost
    FROM per_submission ps
    ORDER BY ps.gene_id, ps.evaluated_at DESC, ps.submission_id
  ),
  sample AS (
    SELECT l.avg_latency_ms, l.avg_cost
    FROM latest l
    WHERE l.succeeded > 0
      AND NOT EXISTS (
        SELECT 1 FROM arena_entries ae
        WHERE ae.gene_id = l.gene_id AND ae.invalidation_reason IS NOT NULL
      )
  ),
  medians AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sample.avg_latency_ms) AS l_ref_ms,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY sample.avg_cost)       AS cost_ref,
           count(*)::INTEGER                                                  AS sample_genes
    FROM sample
  )
  SELECT m.l_ref_ms, m.cost_ref, m.sample_genes, season.season_number
  FROM medians m CROSS JOIN season
  WHERE m.sample_genes >= season.min_genes
    AND m.l_ref_ms > 0
    AND m.cost_ref > 0;
$$;

COMMENT ON FUNCTION get_fitness_reference(TEXT, TEXT) IS
  'ADR-318 D2: L_ref / Cost_ref for F(g) — the current-season median latency (ms) and resource cost of published Genes in the given domain and fidelity, from their owners'' latest sandbox evaluation. No row when the sample is below the season''s fitness_reference_min_genes (default 5); callers fall back to their constants.';

-- Postgres grants EXECUTE to PUBLIC by default; state the grants instead.
REVOKE ALL ON FUNCTION get_fitness_reference(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_fitness_reference(TEXT, TEXT) TO anon, authenticated, service_role;

-- What each Arena row's F(g) was scaled by, so it can be recomputed later from
-- the row alone. NULL on rows written before this migration: those used the
-- fixed constants, recorded nowhere.
ALTER TABLE arena_entries
  ADD COLUMN IF NOT EXISTS l_ref_ms          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS cost_ref          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS fitness_reference TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_fitness_reference') THEN
    ALTER TABLE arena_entries ADD CONSTRAINT chk_arena_fitness_reference CHECK (
      (fitness_reference IS NULL AND l_ref_ms IS NULL AND cost_ref IS NULL)
      -- IS NOT NULL spelled out: `NULL > 0` is NULL, and a CHECK passes on NULL.
      OR (fitness_reference IN ('season-median', 'fallback')
          AND l_ref_ms IS NOT NULL AND cost_ref IS NOT NULL
          AND l_ref_ms > 0 AND cost_ref > 0)
    );
  END IF;
END $$;

COMMENT ON COLUMN arena_entries.fitness_reference IS
  'Where l_ref_ms / cost_ref came from: ''season-median'' (get_fitness_reference) or ''fallback'' (the CLI''s fixed constants, used while the season sample is too small). NULL = written before the reference scale was recorded; the fixed constants applied.';
COMMENT ON COLUMN arena_entries.l_ref_ms IS 'L_ref the F(g) latency term was scaled by, in ms (ADR-318 D2).';
COMMENT ON COLUMN arena_entries.cost_ref IS 'Cost_ref the F(g) resource term was scaled by, in fuel (ADR-318 D2).';
