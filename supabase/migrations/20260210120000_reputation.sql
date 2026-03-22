-- ============================================================
-- Migration 003: Reputation System
-- Rotifer Protocol v0.5.0-alpha.1
-- ============================================================

-- Gene reputation history
CREATE TABLE IF NOT EXISTS gene_reputation (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  gene_id UUID REFERENCES genes(id) ON DELETE CASCADE NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  arena_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  usage_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  stability_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  epoch INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gene_reputation_gene_id ON gene_reputation(gene_id);
CREATE INDEX IF NOT EXISTS idx_gene_reputation_computed ON gene_reputation(computed_at DESC);

-- Developer reputation
CREATE TABLE IF NOT EXISTS developer_reputation (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL UNIQUE,
  score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  genes_published INTEGER NOT NULL DEFAULT 0,
  total_downloads BIGINT NOT NULL DEFAULT 0,
  arena_wins INTEGER NOT NULL DEFAULT 0,
  community_bonus DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_reputation_score ON developer_reputation(score DESC);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_dev_reputation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_dev_reputation_updated
  BEFORE UPDATE ON developer_reputation
  FOR EACH ROW EXECUTE FUNCTION update_dev_reputation_timestamp();

-- Add reputation_score column to genes table
ALTER TABLE genes ADD COLUMN IF NOT EXISTS reputation_score DOUBLE PRECISION DEFAULT 0.0;

-- Function: compute gene reputation
-- R(g) = α·arena + β·usage + γ·stability
-- α=0.5, β=0.3, γ=0.2
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
  -- Arena score: latest fitness value (normalized)
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

  -- Stability score: based on total_calls consistency
  SELECT total_calls INTO v_total_calls
  FROM arena_entries
  WHERE gene_id = p_gene_id;

  IF v_total_calls IS NOT NULL AND v_total_calls > 0 THEN
    v_stability_score := LEAST(v_total_calls::DOUBLE PRECISION / 100.0, 1.0);
  END IF;

  -- Weighted sum
  v_reputation := 0.5 * v_arena_score + 0.3 * v_usage_score + 0.2 * v_stability_score;

  -- Insert reputation record
  INSERT INTO gene_reputation (gene_id, score, arena_score, usage_score, stability_score, epoch)
  VALUES (p_gene_id, v_reputation, v_arena_score, v_usage_score, v_stability_score,
          (SELECT COALESCE(MAX(epoch), 0) + 1 FROM gene_reputation WHERE gene_id = p_gene_id));

  -- Update genes table
  UPDATE genes SET reputation_score = v_reputation WHERE id = p_gene_id;

  RETURN v_reputation;
END;
$$ LANGUAGE plpgsql;

-- Function: compute developer reputation
-- R(d) = avg(R(g_i)) + community_bonus
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
  -- Average gene reputation
  SELECT COALESCE(AVG(reputation_score), 0.0), COUNT(*), COALESCE(SUM(downloads), 0)
  INTO v_avg_gene_rep, v_genes_count, v_total_dl
  FROM genes
  WHERE owner_id = p_user_id AND published = true;

  -- Arena wins (rank #1 count)
  SELECT COUNT(*) INTO v_arena_wins
  FROM arena_entries ae
  JOIN genes g ON ae.gene_id = g.id
  WHERE g.owner_id = p_user_id
    AND ae.fitness_value = (
      SELECT MAX(ae2.fitness_value) FROM arena_entries ae2 WHERE ae2.domain = ae.domain
    );

  -- Community bonus (capped at 0.2)
  v_community_bonus := LEAST(v_arena_wins::DOUBLE PRECISION * 0.02, 0.2);

  v_reputation := v_avg_gene_rep + v_community_bonus;

  -- Upsert developer reputation
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
$$ LANGUAGE plpgsql;

-- Function: apply reputation decay
-- R(g, t) = R(g, t-1) × (1 - decay_rate), decay_rate = 0.05/month
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
$$ LANGUAGE plpgsql;

-- Function: get reputation leaderboard
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

-- RLS policies for reputation tables
ALTER TABLE gene_reputation ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_reputation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Gene reputation readable by all"
  ON gene_reputation FOR SELECT
  USING (true);

CREATE POLICY "Developer reputation readable by all"
  ON developer_reputation FOR SELECT
  USING (true);

CREATE POLICY "Gene reputation writable by service role"
  ON gene_reputation FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Developer reputation writable by service role"
  ON developer_reputation FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Developer reputation updatable by service role"
  ON developer_reputation FOR UPDATE
  USING (true);
