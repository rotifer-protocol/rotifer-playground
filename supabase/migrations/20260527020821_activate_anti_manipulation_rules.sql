-- ============================================================
-- Migration: Activate §33.4 Anti-Manipulation Rules
-- Rotifer Protocol v0.9
--
-- Replaces naive refresh_contribution_metrics() with 4-rule filter:
--   Rule 1: Self-Invocation Exclusion
--   Rule 2: Time-Window Deduplication (5-min per caller-gene pair)
--   Rule 3: Call-Loop Detection (max 1 valid per caller-gene per 24h)
--   Rule 4: Minimum Unique Callers threshold from season_params
--
-- Also updates log_gene_invocation to populate is_self_invocation
-- via existing trigger (no change needed — trigger already works).
-- ============================================================

BEGIN;

-- Helper index for time-window deduplication queries
CREATE INDEX IF NOT EXISTS idx_invocation_gene_caller_time
  ON gene_invocation_log(gene_id, caller_agent_id, invoked_at);

-- Rewrite refresh_contribution_metrics with §33.4 rules
CREATE OR REPLACE FUNCTION refresh_contribution_metrics()
RETURNS INTEGER AS $$
DECLARE
  v_affected INTEGER := 0;
  v_min_unique_callers INTEGER := 2;
BEGIN
  -- Read min_unique_callers from active season config (fallback 2)
  SELECT (config->>'min_unique_callers')::INTEGER
  INTO v_min_unique_callers
  FROM seasons
  WHERE status = 'active'
  LIMIT 1;

  IF v_min_unique_callers IS NULL THEN
    v_min_unique_callers := 2;
  END IF;

  INSERT INTO gene_contribution_metrics (
    gene_id, total_invocations, unique_callers,
    invocations_last_30d, updated_at
  )
  SELECT
    g.id,
    COALESCE(agg.total_invocations, 0),
    COALESCE(agg.unique_callers, 0),
    COALESCE(agg.invocations_last_30d, 0),
    now()
  FROM genes g
  LEFT JOIN (
    SELECT
      gene_id,
      COUNT(*)::INTEGER AS total_invocations,
      COUNT(DISTINCT caller_agent_id)::INTEGER AS unique_callers,
      COUNT(*) FILTER (
        WHERE invoked_at >= now() - INTERVAL '30 days'
      )::INTEGER AS invocations_last_30d
    FROM (
      -- §33.4 Rule 1+2+3 filtered invocations
      SELECT gene_id, caller_agent_id, invoked_at
      FROM (
        SELECT
          gene_id,
          caller_agent_id,
          invoked_at,
          is_self_invocation,
          -- Rule 2: Time-window dedup (5-min per caller-gene pair)
          LAG(invoked_at) OVER (
            PARTITION BY gene_id, caller_agent_id
            ORDER BY invoked_at
          ) AS prev_invoked_at,
          -- Rule 3: Call-loop detection (max 1 per caller-gene per 24h)
          ROW_NUMBER() OVER (
            PARTITION BY gene_id, caller_agent_id,
              DATE_TRUNC('day', invoked_at)
            ORDER BY invoked_at
          ) AS daily_rank
        FROM gene_invocation_log
      ) windowed
      WHERE
        -- Rule 1: Exclude self-invocations
        is_self_invocation = false
        -- Rule 2: At least 5 min since same caller's last call to same gene
        AND (prev_invoked_at IS NULL
             OR invoked_at - prev_invoked_at >= INTERVAL '5 minutes')
        -- Rule 3: Max 1 valid invocation per caller-gene per calendar day
        AND daily_rank = 1
    ) valid_invocations
    GROUP BY gene_id
    -- Rule 4: Only count genes with enough unique callers
    HAVING COUNT(DISTINCT caller_agent_id) >= v_min_unique_callers
  ) agg ON agg.gene_id = g.id
  WHERE g.published = true
  ON CONFLICT (gene_id) DO UPDATE SET
    total_invocations = EXCLUDED.total_invocations,
    unique_callers = EXCLUDED.unique_callers,
    invocations_last_30d = EXCLUDED.invocations_last_30d,
    updated_at = now();

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION refresh_contribution_metrics() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION refresh_contribution_metrics() FROM anon;
REVOKE EXECUTE ON FUNCTION refresh_contribution_metrics() FROM authenticated;

-- Update the comment in compute_all_reputations to reflect activation
COMMENT ON FUNCTION refresh_contribution_metrics() IS
  '§33.4 Anti-Manipulation activated (v0.9): Self-exclusion + 5min dedup + daily cap + min_unique_callers threshold';

COMMIT;
