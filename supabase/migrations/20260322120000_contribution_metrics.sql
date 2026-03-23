-- ============================================================
-- v0.8: ContributionMetrics — data model + invocation tracking
-- Spec: §23.1 ContributionMetrics, §33.4 Anti-Manipulation
-- Decision D-01: v0.8 data collection only, v0.9 rule activation
-- ============================================================

-- 1. Gene Invocation Log — every Gene invocation with caller identity
CREATE TABLE IF NOT EXISTS gene_invocation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gene_id UUID NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
  caller_agent_id TEXT NOT NULL,
  gene_author_id UUID,
  invoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_self_invocation BOOLEAN GENERATED ALWAYS AS (
    caller_agent_id = gene_author_id::TEXT
  ) STORED
);

CREATE INDEX idx_invocation_gene_caller
  ON gene_invocation_log(gene_id, caller_agent_id);
CREATE INDEX idx_invocation_time
  ON gene_invocation_log(invoked_at);
CREATE INDEX idx_invocation_gene_time
  ON gene_invocation_log(gene_id, invoked_at DESC);

-- Auto-populate gene_author_id from genes table
CREATE OR REPLACE FUNCTION populate_gene_author_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.gene_author_id IS NULL THEN
    SELECT owner_id INTO NEW.gene_author_id
    FROM genes WHERE id = NEW.gene_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = 'public';

CREATE TRIGGER trg_populate_gene_author
  BEFORE INSERT ON gene_invocation_log
  FOR EACH ROW
  EXECUTE FUNCTION populate_gene_author_id();

-- 2. Gene Contribution Metrics — aggregated (§23.1 ContributionMetrics)
CREATE TABLE IF NOT EXISTS gene_contribution_metrics (
  gene_id UUID PRIMARY KEY REFERENCES genes(id) ON DELETE CASCADE,
  total_invocations INTEGER NOT NULL DEFAULT 0,
  unique_callers INTEGER NOT NULL DEFAULT 0,
  invocations_last_30d INTEGER NOT NULL DEFAULT 0,
  derivation_count INTEGER NOT NULL DEFAULT 0,
  composition_count INTEGER NOT NULL DEFAULT 0,
  downstream_success_rate DOUBLE PRECISION DEFAULT 1.0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. RLS

ALTER TABLE gene_invocation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE gene_contribution_metrics ENABLE ROW LEVEL SECURITY;

-- §9.7.1: ContributionMetrics raw data MUST be publicly verifiable
CREATE POLICY "Invocation log publicly readable"
  ON gene_invocation_log FOR SELECT
  USING (true);

CREATE POLICY "Invocation log insert blocked for users"
  ON gene_invocation_log FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Contribution metrics publicly readable"
  ON gene_contribution_metrics FOR SELECT
  USING (true);

CREATE POLICY "Contribution metrics not directly writable"
  ON gene_contribution_metrics FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Contribution metrics not directly updatable"
  ON gene_contribution_metrics FOR UPDATE
  USING (false);

-- 4. Refresh function — aggregate invocation_log → contribution_metrics
-- v0.8: counts ALL invocations (anti-manipulation filtering deferred to v0.9)
CREATE OR REPLACE FUNCTION refresh_contribution_metrics()
RETURNS INTEGER AS $$
DECLARE
  v_affected INTEGER := 0;
BEGIN
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
    FROM gene_invocation_log
    GROUP BY gene_id
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

-- 5. Update compute_all_reputations — prepend ContributionMetrics refresh
CREATE OR REPLACE FUNCTION compute_all_reputations()
RETURNS void AS $$
DECLARE
  v_gene RECORD;
  v_dev RECORD;
  v_log_id UUID;
  v_today DATE := CURRENT_DATE;
  v_gene_count INTEGER := 0;
  v_dev_count INTEGER := 0;
  v_cm_count INTEGER := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM reputation_compute_log
    WHERE compute_type = 'gene' AND status = 'success'
    AND started_at::DATE = v_today
  ) THEN
    RETURN;
  END IF;

  -- Step 0: Refresh ContributionMetrics (§23.1)
  -- ⚠️ Anti-manipulation rules NOT activated (v0.9 per D-01)
  INSERT INTO reputation_compute_log (compute_type, affected_count, status)
  VALUES ('contribution_metrics', 0, 'running') RETURNING id INTO v_log_id;

  v_cm_count := refresh_contribution_metrics();

  UPDATE reputation_compute_log
  SET affected_count = v_cm_count,
      finished_at = now(), status = 'success'
  WHERE id = v_log_id;

  -- Step 1: Gene reputations
  INSERT INTO reputation_compute_log (compute_type, affected_count, status)
  VALUES ('gene', 0, 'running') RETURNING id INTO v_log_id;

  FOR v_gene IN SELECT id FROM genes WHERE published = true LOOP
    PERFORM compute_gene_reputation(v_gene.id);
    v_gene_count := v_gene_count + 1;
  END LOOP;

  UPDATE reputation_compute_log
  SET affected_count = v_gene_count,
      finished_at = now(), status = 'success'
  WHERE id = v_log_id;

  -- Step 2: Developer reputations
  INSERT INTO reputation_compute_log (compute_type, affected_count, status)
  VALUES ('developer', 0, 'running') RETURNING id INTO v_log_id;

  FOR v_dev IN SELECT DISTINCT owner_id FROM genes WHERE published = true LOOP
    PERFORM compute_developer_reputation(v_dev.owner_id);
    v_dev_count := v_dev_count + 1;
  END LOOP;

  UPDATE reputation_compute_log
  SET affected_count = v_dev_count,
      finished_at = now(), status = 'success'
  WHERE id = v_log_id;

EXCEPTION WHEN OTHERS THEN
  UPDATE reputation_compute_log
  SET finished_at = now(), status = 'error', error_message = SQLERRM
  WHERE id = v_log_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION compute_all_reputations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION compute_all_reputations() FROM anon;
REVOKE EXECUTE ON FUNCTION compute_all_reputations() FROM authenticated;

-- 6. RPC entry point — called by Edge Functions via service_role
CREATE OR REPLACE FUNCTION log_gene_invocation(
  p_gene_id UUID,
  p_caller_agent_id TEXT
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO gene_invocation_log (gene_id, caller_agent_id)
  VALUES (p_gene_id, p_caller_agent_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION log_gene_invocation(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION log_gene_invocation(UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION log_gene_invocation(UUID, TEXT) FROM authenticated;

-- 7. Data retention — keep 90d for §33.4 loop detection window
CREATE OR REPLACE FUNCTION cleanup_old_invocation_logs()
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM gene_invocation_log
  WHERE invoked_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION cleanup_old_invocation_logs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cleanup_old_invocation_logs() FROM anon;
REVOKE EXECUTE ON FUNCTION cleanup_old_invocation_logs() FROM authenticated;

SELECT cron.schedule(
  'weekly-invocation-log-cleanup',
  '0 2 * * 0',
  $$SELECT cleanup_old_invocation_logs()$$
);
