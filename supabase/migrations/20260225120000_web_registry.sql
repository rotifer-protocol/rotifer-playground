-- ============================================================
-- Migration 004: Web Registry Support
-- Rotifer Protocol v0.6
-- ============================================================

-- Add readme column to genes table
ALTER TABLE genes ADD COLUMN IF NOT EXISTS readme TEXT;

-- Arena history view for tracking fitness over time
CREATE OR REPLACE VIEW arena_history AS
SELECT
  ae.gene_id,
  g.name AS gene_name,
  ae.domain,
  ae.fitness_value,
  ae.safety_score,
  ae.total_calls,
  ae.last_evaluated,
  ae.created_at
FROM arena_entries ae
JOIN genes g ON g.id = ae.gene_id
WHERE g.published = true
ORDER BY ae.last_evaluated DESC;

-- Function: get gene stats (downloads over time periods)
CREATE OR REPLACE FUNCTION get_gene_stats(p_gene_id UUID)
RETURNS JSON AS $$
DECLARE
  v_total BIGINT;
  v_last_7d BIGINT;
  v_last_30d BIGINT;
  v_last_90d BIGINT;
BEGIN
  SELECT downloads INTO v_total FROM genes WHERE id = p_gene_id;

  SELECT COUNT(*) INTO v_last_7d
  FROM downloads
  WHERE gene_id = p_gene_id AND created_at >= now() - interval '7 days';

  SELECT COUNT(*) INTO v_last_30d
  FROM downloads
  WHERE gene_id = p_gene_id AND created_at >= now() - interval '30 days';

  SELECT COUNT(*) INTO v_last_90d
  FROM downloads
  WHERE gene_id = p_gene_id AND created_at >= now() - interval '90 days';

  RETURN json_build_object(
    'total', COALESCE(v_total, 0),
    'last_7d', COALESCE(v_last_7d, 0),
    'last_30d', COALESCE(v_last_30d, 0),
    'last_90d', COALESCE(v_last_90d, 0)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
