-- ============================================================
-- ADR-319 D4, plan 3.1: a leaderboard that says what it knows
--
-- Until now every Arena row was ranked the same way: order by fitness_value,
-- print a number. A score derived from a content hash, a score typed in by
-- hand, and a score measured in the sandbox all looked identical — and a row
-- disqualified by the published criteria still sat at the top, because nothing
-- on the read side ever consulted `invalidated_at`. The partial index built for
-- exactly that filter had no reader.
--
-- This adds one: `get_arena_leaderboard` returns every row with the tier it has
-- earned, and — this is the part that matters more than the ordering — the
-- reason it is in that tier. An author whose gene stopped ranking can see why
-- without anyone having to announce it.
--
--   verified          measured by a sandbox or a binding runtime, and used by
--                     at least MIN_UNIQUE_CALLERS distinct callers (§33.4
--                     Rule 2, threshold read from the active season's config
--                     rather than hardcoded)
--   under_evaluation  measured, but not yet used by enough distinct callers.
--                     Ranked within its own tier: the measurement is real, the
--                     evidence of demand is not yet there.
--   not_evaluated     nothing was measured (estimated / declared /
--                     unknown-legacy), or the row is disqualified. No rank, and
--                     the caller is expected to render "—" rather than the
--                     stored number — a hash-derived 0.5 shown as a score is
--                     how this whole problem started.
--
-- `estimated` sits in not_evaluated on purpose. "Under evaluation" should mean
-- a measurement happened and the evidence is still thin; an estimate ran
-- nothing at all, and putting it in the same tier as a real sandbox run would
-- reintroduce the confusion the tiers exist to end.
--
-- One row per logical gene. `contract-revision-advisor` has nine versions on
-- the board; showing nine rows told the reader nothing except that the author
-- published often. The newest version that is not disqualified wins, falling
-- back to the newest of any state so a gene never vanishes entirely — an
-- author whose every version is disqualified most needs to see that.
--
-- Additive per ADR-295: one new function. `get_arena_rankings` is left exactly
-- as it is (its return type cannot change in place, and replacing it would be
-- a breaking change for anything still pointed at it).
-- ============================================================

CREATE OR REPLACE FUNCTION arena_min_unique_callers()
RETURNS INTEGER
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT COALESCE(
    (SELECT (config->>'min_unique_callers')::INTEGER
       FROM seasons WHERE status = 'active'
      ORDER BY season_number DESC LIMIT 1),
    2
  );
$$;

COMMENT ON FUNCTION arena_min_unique_callers() IS
  '§33.4 Rule 2 threshold, read from the active season config so it stays a season parameter rather than a constant compiled into a query.';

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
    t.fitness_value DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION get_arena_leaderboard(TEXT, INTEGER, INTEGER) IS
  'ADR-319 D4 / plan 3.1: the Arena leaderboard, one row per logical gene, carrying the tier it earned and the reason. Disqualified rows appear in not_evaluated with their invalidation_reason rather than disappearing — an author needs to see why. Supersedes get_arena_rankings, which ranks every row alike and never consults invalidated_at.';

GRANT EXECUTE ON FUNCTION get_arena_leaderboard(TEXT, INTEGER, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION arena_min_unique_callers() TO anon, authenticated;
