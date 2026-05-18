-- Follow-up fixes after D52-D58 review:
-- 1. Preserve legacy track_download(uuid) as a wrapper to track_download(uuid,text)
-- 2. Revoke accidental PUBLIC execute on the new overloaded RPC
-- 3. Separate developer reputation scoring inputs from displayed metadata

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
    v_gene_contribution := v_sum_rep * ln(1.0 + v_contributing_gene_count) / v_contributing_gene_count;
  END IF;

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

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_id
    FROM genes
    WHERE published = true
      AND owner_id IS NOT NULL
  LOOP
    PERFORM compute_developer_reputation(r.owner_id);
  END LOOP;
END;
$$;
