-- ADR-214: downloads.source field + track_download p_source parameter
-- ADR-214: compute_gene_reputation dynamic weights (W0/W1/W2)
-- ADR-216: compute_developer_reputation AVG → weighted Σ

------------------------------------------------------------------------
-- D52: Add source column to downloads table
------------------------------------------------------------------------
ALTER TABLE downloads ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'cli';

------------------------------------------------------------------------
-- D52: Rewrite track_download with p_source parameter
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION track_download(p_gene_id UUID, p_source TEXT DEFAULT 'cli')
RETURNS VOID AS $$
DECLARE
  v_caller UUID;
  v_ip_hash text;
  v_safe_source text;
BEGIN
  v_safe_source := CASE
    WHEN p_source IN ('cli', 'mcp', 'api', 'web') THEN p_source
    ELSE 'cli'
  END;

  v_caller := auth.uid();

  IF v_caller IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM downloads
      WHERE gene_id = p_gene_id
        AND user_id = v_caller
        AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN;
    END IF;

    INSERT INTO downloads (gene_id, user_id, source)
    VALUES (p_gene_id, v_caller, v_safe_source);
  ELSE
    v_ip_hash := 'anon-' || substr(md5(coalesce(inet_client_addr()::text, 'unknown')), 1, 12);

    IF EXISTS (
      SELECT 1 FROM downloads
      WHERE gene_id = p_gene_id
        AND ip_hash = v_ip_hash
        AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN;
    END IF;

    INSERT INTO downloads (gene_id, ip_hash, source)
    VALUES (p_gene_id, v_ip_hash, v_safe_source);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

-- Preserve the legacy one-argument RPC for older clients.
CREATE OR REPLACE FUNCTION track_download(p_gene_id UUID)
RETURNS VOID AS $$
BEGIN
  PERFORM track_download(p_gene_id, 'cli');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION track_download(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION track_download(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION track_download(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION track_download(UUID) TO anon;
GRANT EXECUTE ON FUNCTION track_download(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION track_download(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION track_download(UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION track_download(UUID, TEXT) TO service_role;

------------------------------------------------------------------------
-- D53: compute_gene_reputation with dynamic weights (W0/W1/W2)
------------------------------------------------------------------------
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
  v_ecosystem_dl BIGINT;
  v_w_arena DOUBLE PRECISION;
  v_w_usage DOUBLE PRECISION;
  v_w_stability DOUBLE PRECISION;
BEGIN
  -- Determine ecosystem phase from total downloads
  SELECT COALESCE(SUM(downloads), 0) INTO v_ecosystem_dl FROM genes;

  IF v_ecosystem_dl < 100 THEN
    -- W0: Cold start — usage data too sparse to be meaningful
    v_w_arena := 0.70;  v_w_usage := 0.05;  v_w_stability := 0.25;
  ELSIF v_ecosystem_dl < 10000 THEN
    -- W1: Normal growth
    v_w_arena := 0.60;  v_w_usage := 0.20;  v_w_stability := 0.20;
  ELSE
    -- W2: Mature ecosystem
    v_w_arena := 0.50;  v_w_usage := 0.30;  v_w_stability := 0.20;
  END IF;

  -- Arena score: latest fitness_value
  SELECT fitness_value INTO v_fitness
  FROM arena_entries
  WHERE gene_id = p_gene_id
  ORDER BY last_evaluated DESC
  LIMIT 1;

  IF v_fitness IS NOT NULL THEN
    v_arena_score := v_fitness;
  END IF;

  -- Usage score: log-scaled downloads
  SELECT downloads INTO v_downloads
  FROM genes
  WHERE id = p_gene_id;

  IF v_downloads IS NOT NULL AND v_downloads > 0 THEN
    v_usage_score := LEAST(ln(v_downloads::DOUBLE PRECISION + 1) / ln(1000.0), 1.0);
  END IF;

  -- Stability score: log-scaled arena call depth
  SELECT COALESCE(SUM(total_calls), 0) INTO v_total_calls
  FROM arena_entries
  WHERE gene_id = p_gene_id;

  IF v_total_calls > 0 THEN
    v_stability_score := LEAST(ln(v_total_calls::DOUBLE PRECISION + 1) / ln(101.0), 1.0);
  END IF;

  v_reputation := v_w_arena * v_arena_score
                + v_w_usage * v_usage_score
                + v_w_stability * v_stability_score;

  INSERT INTO gene_reputation (gene_id, score, arena_score, usage_score, stability_score, epoch)
  VALUES (p_gene_id, v_reputation, v_arena_score, v_usage_score, v_stability_score,
          (SELECT COALESCE(MAX(epoch), 0) + 1 FROM gene_reputation WHERE gene_id = p_gene_id));

  UPDATE genes SET reputation_score = v_reputation WHERE id = p_gene_id;

  RETURN v_reputation;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

------------------------------------------------------------------------
-- D57: compute_developer_reputation AVG → quality-weighted Σ
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_developer_reputation(p_user_id UUID)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_gene_contribution DOUBLE PRECISION := 0.0;
  v_sum_rep DOUBLE PRECISION := 0.0;
  v_contributing_gene_count INTEGER := 0;
  v_genes_published INTEGER := 0;
  v_total_dl BIGINT := 0;
  v_arena_wins INTEGER := 0;
  v_community_bonus DOUBLE PRECISION := 0.0;
  v_reputation DOUBLE PRECISION;
BEGIN
  -- Public metadata should reflect all latest published genes, regardless of score.
  SELECT COUNT(*),
         COALESCE(SUM(lg.downloads), 0)
  INTO v_genes_published, v_total_dl
  FROM (
    SELECT DISTINCT ON (g.owner_id, g.name)
      g.downloads
    FROM genes g
    WHERE g.owner_id = p_user_id
      AND g.published = true
    ORDER BY g.owner_id, g.name, g.created_at DESC
  ) lg;

  -- Quality-weighted sum: SUM(R(g)) × ln(1+count) / count
  -- Excludes zero-score genes to prevent spam inflation
  SELECT COALESCE(SUM(lg.reputation_score), 0.0),
         COUNT(*)
  INTO v_sum_rep, v_contributing_gene_count
  FROM (
    SELECT DISTINCT ON (g.owner_id, g.name)
      g.reputation_score
    FROM genes g
    WHERE g.owner_id = p_user_id
      AND g.published = true
      AND g.reputation_score > 0
    ORDER BY g.owner_id, g.name, g.created_at DESC
  ) lg;

  IF v_contributing_gene_count > 0 THEN
    -- ln(1+count)/count provides diminishing marginal returns per gene
    v_gene_contribution := v_sum_rep * ln(1.0 + v_contributing_gene_count) / v_contributing_gene_count;
  END IF;

  -- Arena wins (rank #1 count)
  SELECT COUNT(*) INTO v_arena_wins
  FROM arena_entries ae
  JOIN genes g ON ae.gene_id = g.id
  WHERE g.owner_id = p_user_id
    AND ae.fitness_value = (
      SELECT MAX(ae2.fitness_value) FROM arena_entries ae2 WHERE ae2.domain = ae.domain
    );

  v_community_bonus := LEAST(v_arena_wins::DOUBLE PRECISION * 0.02, 0.2);
  v_reputation := v_gene_contribution + v_community_bonus;

  INSERT INTO developer_reputation (user_id, score, genes_published, total_downloads, arena_wins, community_bonus)
  VALUES (p_user_id, v_reputation, v_genes_published, v_total_dl, v_arena_wins, v_community_bonus)
  ON CONFLICT (user_id) DO UPDATE SET
    score = EXCLUDED.score,
    genes_published = EXCLUDED.genes_published,
    total_downloads = EXCLUDED.total_downloads,
    arena_wins = EXCLUDED.arena_wins,
    community_bonus = EXCLUDED.community_bonus;

  RETURN v_reputation;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';
