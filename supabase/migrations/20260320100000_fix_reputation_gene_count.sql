-- Migration: Fix compute_developer_reputation to count unique genes only
--
-- Bug: COUNT(*) counted all published rows including multiple versions
-- of the same gene, inflating genes_published (e.g. 60 instead of 62).
-- AVG(reputation_score) and SUM(downloads) were also skewed by
-- duplicate version rows.
--
-- Fix: Use DISTINCT ON (owner_id, name) to isolate the latest version
-- per gene before aggregating.

CREATE OR REPLACE FUNCTION compute_developer_reputation(p_user_id UUID)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_avg_gene_rep DOUBLE PRECISION := 0.0;
  v_genes_count INTEGER := 0;
  v_total_dl BIGINT := 0;
  v_arena_wins INTEGER := 0;
  v_community_bonus DOUBLE PRECISION := 0.0;
  v_reputation DOUBLE PRECISION;
BEGIN
  SELECT COALESCE(AVG(lg.reputation_score), 0.0),
         COUNT(*),
         COALESCE(SUM(lg.downloads), 0)
  INTO v_avg_gene_rep, v_genes_count, v_total_dl
  FROM (
    SELECT DISTINCT ON (g.owner_id, g.name)
      g.reputation_score,
      g.downloads
    FROM genes g
    WHERE g.owner_id = p_user_id AND g.published = true
    ORDER BY g.owner_id, g.name, g.created_at DESC
  ) lg;

  -- Arena wins (rank #1 count)
  SELECT COUNT(*) INTO v_arena_wins
  FROM arena_entries ae
  JOIN genes g ON ae.gene_id = g.id
  WHERE g.owner_id = p_user_id
    AND ae.fitness_value = (
      SELECT MAX(ae2.fitness_value) FROM arena_entries ae2 WHERE ae2.domain = ae.domain
    );

  v_community_bonus := LEAST(v_arena_wins::DOUBLE PRECISION * 0.02, 0.2);
  v_reputation := v_avg_gene_rep + v_community_bonus;

  INSERT INTO developer_reputation (user_id, score, genes_published, total_downloads, arena_wins, community_bonus)
  VALUES (p_user_id, v_reputation, v_genes_count, v_total_dl, v_arena_wins, v_community_bonus)
  ON CONFLICT (user_id) DO UPDATE SET
    score = EXCLUDED.score,
    genes_published = EXCLUDED.genes_published,
    total_downloads = EXCLUDED.total_downloads,
    arena_wins = EXCLUDED.arena_wins,
    community_bonus = EXCLUDED.community_bonus;

  RETURN v_reputation;
END;
$$ LANGUAGE plpgsql
SET search_path = 'public';
