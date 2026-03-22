-- ============================================================
-- v0.8: Epoch Automation — pg_cron + compute_all_reputations
-- ============================================================

-- 1. Compute history / error tracking table
CREATE TABLE IF NOT EXISTS reputation_compute_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compute_type TEXT NOT NULL,
  affected_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  error_message TEXT
);

ALTER TABLE reputation_compute_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Compute log read-only for authenticated"
  ON reputation_compute_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Compute log not directly writable"
  ON reputation_compute_log FOR INSERT
  WITH CHECK (false);

-- 2. Batch compute function (idempotent per day)
CREATE OR REPLACE FUNCTION compute_all_reputations()
RETURNS void AS $$
DECLARE
  v_gene RECORD;
  v_dev RECORD;
  v_log_id UUID;
  v_today DATE := CURRENT_DATE;
  v_gene_count INTEGER := 0;
  v_dev_count INTEGER := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM reputation_compute_log
    WHERE compute_type = 'gene' AND status = 'success'
    AND started_at::DATE = v_today
  ) THEN
    RETURN;
  END IF;

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

-- 3. pg_cron jobs
-- Daily 00:00 UTC: Gene + Developer Reputation
SELECT cron.schedule(
  'daily-reputation-compute',
  '0 0 * * *',
  $$SELECT compute_all_reputations()$$
);

-- Monthly 1st 00:30 UTC: Reputation decay
SELECT cron.schedule(
  'monthly-reputation-decay',
  '30 0 1 * *',
  $$SELECT apply_reputation_decay()$$
);
