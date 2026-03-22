-- ============================================================
-- Migration 005: Security Hardening
-- Rotifer Protocol v0.7
--
-- Fixes identified in: reports/supabase-security-audit-prep.md
-- Addresses: C1, C2, W1, W2, W3, W4, W5
-- ============================================================

BEGIN;

-- =====================
-- C1 FIX: Lock down reputation table writes
--
-- The original policies used WITH CHECK (true) which allows
-- ANY authenticated or anonymous user to write directly via
-- PostgREST, bypassing compute_*_reputation() functions.
-- =====================

DROP POLICY IF EXISTS "Gene reputation writable by service role" ON gene_reputation;
DROP POLICY IF EXISTS "Developer reputation writable by service role" ON developer_reputation;
DROP POLICY IF EXISTS "Developer reputation updatable by service role" ON developer_reputation;

CREATE POLICY "Gene reputation not directly writable"
  ON gene_reputation FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Developer reputation not directly writable"
  ON developer_reputation FOR INSERT
  WITH CHECK (false);

CREATE POLICY "Developer reputation not directly updatable"
  ON developer_reputation FOR UPDATE
  USING (false);

-- =====================
-- W1 FIX: Mark reputation compute functions as SECURITY DEFINER
--
-- After C1 locks down direct writes, these functions need
-- SECURITY DEFINER to write to reputation tables on behalf
-- of the caller. Also restrict who can call them.
-- =====================

CREATE OR REPLACE FUNCTION compute_gene_reputation(p_gene_id UUID)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_arena_score DOUBLE PRECISION := 0.0;
  v_usage_score DOUBLE PRECISION := 0.0;
  v_stability_score DOUBLE PRECISION := 1.0;
  v_fitness DOUBLE PRECISION;
  v_downloads BIGINT;
  v_total_calls INTEGER;
  v_reputation DOUBLE PRECISION;
BEGIN
  SELECT fitness_value INTO v_fitness
  FROM arena_entries
  WHERE gene_id = p_gene_id
  ORDER BY last_evaluated DESC
  LIMIT 1;

  IF v_fitness IS NOT NULL THEN
    v_arena_score := v_fitness;
  END IF;

  SELECT downloads INTO v_downloads
  FROM genes
  WHERE id = p_gene_id;

  IF v_downloads IS NOT NULL AND v_downloads > 0 THEN
    v_usage_score := LEAST(ln(v_downloads::DOUBLE PRECISION + 1) / ln(1000.0), 1.0);
  END IF;

  SELECT total_calls INTO v_total_calls
  FROM arena_entries
  WHERE gene_id = p_gene_id;

  IF v_total_calls IS NOT NULL AND v_total_calls > 0 THEN
    v_stability_score := LEAST(v_total_calls::DOUBLE PRECISION / 100.0, 1.0);
  END IF;

  v_reputation := 0.5 * v_arena_score + 0.3 * v_usage_score + 0.2 * v_stability_score;

  INSERT INTO gene_reputation (gene_id, score, arena_score, usage_score, stability_score, epoch)
  VALUES (p_gene_id, v_reputation, v_arena_score, v_usage_score, v_stability_score,
          (SELECT COALESCE(MAX(epoch), 0) + 1 FROM gene_reputation WHERE gene_id = p_gene_id));

  UPDATE genes SET reputation_score = v_reputation WHERE id = p_gene_id;

  RETURN v_reputation;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
  SELECT COALESCE(AVG(reputation_score), 0.0), COUNT(*), COALESCE(SUM(downloads), 0)
  INTO v_avg_gene_rep, v_genes_count, v_total_dl
  FROM genes
  WHERE owner_id = p_user_id AND published = true;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION compute_gene_reputation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION compute_gene_reputation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION compute_gene_reputation(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION compute_developer_reputation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION compute_developer_reputation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION compute_developer_reputation(UUID) TO authenticated;

-- =====================
-- C2 FIX: Restrict anonymous downloads
-- =====================

DROP POLICY IF EXISTS "Anyone can log downloads" ON downloads;

CREATE POLICY "Authenticated users can log downloads"
  ON downloads FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- =====================
-- W2 FIX: get_gene_stats checks published status
-- =====================

CREATE OR REPLACE FUNCTION get_gene_stats(p_gene_id UUID)
RETURNS JSON AS $$
DECLARE
  v_total BIGINT;
  v_last_7d BIGINT;
  v_last_30d BIGINT;
  v_last_90d BIGINT;
BEGIN
  SELECT downloads INTO v_total FROM genes
  WHERE id = p_gene_id AND published = true;

  IF v_total IS NULL THEN
    RETURN json_build_object('error', 'Gene not found or not published');
  END IF;

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

-- =====================
-- W3 FIX: Limit arena rankings query size
-- =====================

CREATE OR REPLACE FUNCTION get_arena_rankings(
  p_domain text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  rank bigint,
  gene_id uuid,
  gene_name text,
  owner_username text,
  domain text,
  fidelity text,
  fitness_value double precision,
  safety_score double precision,
  total_calls bigint,
  last_evaluated timestamptz
) AS $$
BEGIN
  p_limit := LEAST(p_limit, 200);
  p_offset := GREATEST(p_offset, 0);

  RETURN QUERY
    SELECT
      row_number() OVER (
        PARTITION BY ae.domain ORDER BY ae.fitness_value DESC
      ) AS rank,
      g.id AS gene_id,
      g.name AS gene_name,
      p.username AS owner_username,
      ae.domain,
      g.fidelity,
      ae.fitness_value,
      ae.safety_score,
      ae.total_calls,
      ae.last_evaluated
    FROM arena_entries ae
    JOIN genes g ON g.id = ae.gene_id
    JOIN profiles p ON p.id = g.owner_id
    WHERE g.published = true
      AND (p_domain IS NULL OR ae.domain = p_domain)
    ORDER BY ae.domain, ae.fitness_value DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================
-- W4 FIX: Validate username format in handle_new_user
-- =====================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_username TEXT;
  v_avatar TEXT;
  v_provider_id BIGINT;
BEGIN
  v_username := COALESCE(
    NEW.raw_user_meta_data->>'user_name',
    NEW.raw_user_meta_data->>'preferred_username'
  );
  v_avatar := NEW.raw_user_meta_data->>'avatar_url';
  v_provider_id := (NEW.raw_user_meta_data->>'provider_id')::bigint;

  IF v_username IS NOT NULL THEN
    v_username := regexp_replace(v_username, '[^a-zA-Z0-9_-]', '', 'g');
    IF length(v_username) = 0 THEN
      v_username := 'user_' || substr(NEW.id::text, 1, 8);
    END IF;
  ELSE
    v_username := 'user_' || substr(NEW.id::text, 1, 8);
  END IF;

  IF v_avatar IS NOT NULL AND v_avatar !~ '^https://' THEN
    v_avatar := NULL;
  END IF;

  INSERT INTO public.profiles (id, username, avatar_url, github_id)
  VALUES (
    NEW.id,
    v_username,
    v_avatar,
    v_provider_id
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    avatar_url = EXCLUDED.avatar_url,
    github_id = EXCLUDED.github_id,
    updated_at = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================
-- W5 FIX: Lock down apply_reputation_decay
-- =====================

CREATE OR REPLACE FUNCTION apply_reputation_decay()
RETURNS void AS $$
DECLARE
  v_decay_rate DOUBLE PRECISION := 0.05;
  v_decay_floor DOUBLE PRECISION := 0.01;
BEGIN
  UPDATE genes
  SET reputation_score = GREATEST(reputation_score * (1.0 - v_decay_rate), v_decay_floor)
  WHERE reputation_score > v_decay_floor;

  UPDATE developer_reputation
  SET score = GREATEST(score * (1.0 - v_decay_rate), v_decay_floor)
  WHERE score > v_decay_floor;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION apply_reputation_decay() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION apply_reputation_decay() FROM anon;
REVOKE EXECUTE ON FUNCTION apply_reputation_decay() FROM authenticated;

-- =====================
-- W3 supplement: Also limit get_reputation_leaderboard
-- =====================

CREATE OR REPLACE FUNCTION get_reputation_leaderboard(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
  user_id UUID,
  username TEXT,
  avatar_url TEXT,
  score DOUBLE PRECISION,
  genes_published INTEGER,
  total_downloads BIGINT,
  arena_wins INTEGER
) AS $$
BEGIN
  p_limit := LEAST(p_limit, 100);

  RETURN QUERY
  SELECT
    dr.user_id,
    p.username,
    p.avatar_url,
    dr.score,
    dr.genes_published,
    dr.total_downloads,
    dr.arena_wins
  FROM developer_reputation dr
  JOIN profiles p ON dr.user_id = p.id
  ORDER BY dr.score DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

COMMIT;
