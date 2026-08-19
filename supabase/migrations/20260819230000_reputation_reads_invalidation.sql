-- ============================================================
-- ADR-319 D4 — R(g) reads the invalidation, like the board now does
--
-- The Arena leaderboard stopped ranking disqualified entries. R(g) did not.
-- `compute_gene_reputation` takes the most recent `arena_entries` row for a
-- gene with no filter at all: not on `invalidated_at`, not on
-- `evaluation_method`. So the same number the board withheld came back
-- through a second door, and under the current ecosystem weights it is not a
-- minor term — with ecosystem downloads below 100 the arena weight is 0.70.
--
-- Measured on production before this migration: `hook-guard` carried
-- R(g) = 0.604547620805922. Of that, 0.70 × 0.81 = 0.567 — 94 percent — came
-- from a fitness value invalidated as `async-express-artifact`, i.e. from an
-- artifact the runtime refuses to execute. The gene's own page showed
-- "Score 0.60" while its F(g) already showed "—".
--
-- It propagated further. `compute_developer_reputation` sums gene R(g), and
-- separately counts `arena_wins` by comparing a row's fitness to the maximum
-- in its domain — also unfiltered, so a disqualified 1.000 both won its
-- domain and set a bar no valid entry could reach.
--
-- Three changes, and one deliberate omission:
--
--   1. arena_score requires an entry that is not invalidated AND was actually
--      measured. Same predicate the leaderboard tiers on, extracted into
--      `arena_entry_is_measured()` so the rule has one home rather than three
--      copies drifting apart — a pgTAP test pins it against
--      `get_arena_leaderboard`.
--
--   2. stability_score sums `total_calls` from non-invalidated entries only.
--      It does NOT require a measured method: how a fitness number was
--      derived says nothing about whether calls happened, and an `estimated`
--      entry can still have accumulated real invocations. But calls recorded
--      against a disqualified entry are calls to something that did not run
--      as claimed, and they cannot stand as evidence of stability.
--
--   3. arena_wins counts only valid measurements, and compares against a
--      maximum computed over valid measurements. Both halves have to move:
--      filtering the candidate while leaving the bar unfiltered would simply
--      mean nobody ever wins.
--
--   4. NOT DONE HERE: recomputing the 182 stored scores. Replacing a formula
--      does not restate what is already written, and no trigger fires on the
--      UPDATE that sets `invalidated_at` — which is why the 57 rows
--      invalidated earlier today never disturbed R(g) at all. The backfill is
--      a separate, explicit call (see `recompute_all_published_reputation`
--      below); it changes a public number on every gene and is not something
--      a migration should do on its way past.
--
-- Additive per ADR-295: CREATE OR REPLACE on existing functions, one new
-- helper, one new trigger. No column or table is altered.
-- ============================================================

------------------------------------------------------------------------
-- The predicate, in one place
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION arena_entry_is_measured(p_evaluation_method TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = 'public'
AS $$
  SELECT p_evaluation_method IN ('sandbox', 'binding_runtime');
$$;

COMMENT ON FUNCTION arena_entry_is_measured(TEXT) IS
  'True when a machine actually ran the gene. `estimated` derives a number from the content hash and `declared` takes the client''s word for it; neither is a measurement. Same set `get_arena_leaderboard` tiers on — kept as one function so the rule cannot drift between the board and R(g).';

------------------------------------------------------------------------
-- D53 form, with the gate. Weights and shape unchanged.
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
  SELECT COALESCE(SUM(downloads), 0) INTO v_ecosystem_dl FROM genes;

  IF v_ecosystem_dl < 100 THEN
    v_w_arena := 0.70;  v_w_usage := 0.05;  v_w_stability := 0.25;
  ELSIF v_ecosystem_dl < 10000 THEN
    v_w_arena := 0.60;  v_w_usage := 0.20;  v_w_stability := 0.20;
  ELSE
    v_w_arena := 0.50;  v_w_usage := 0.30;  v_w_stability := 0.20;
  END IF;

  -- Only a standing measurement may contribute a fitness term.
  SELECT ae.fitness_value INTO v_fitness
  FROM arena_entries ae
  WHERE ae.gene_id = p_gene_id
    AND ae.invalidated_at IS NULL
    AND arena_entry_is_measured(ae.evaluation_method)
  ORDER BY ae.last_evaluated DESC
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

  -- Calls still count regardless of how the fitness was derived, but not
  -- calls booked against an entry the criteria disqualified.
  SELECT COALESCE(SUM(ae.total_calls), 0) INTO v_total_calls
  FROM arena_entries ae
  WHERE ae.gene_id = p_gene_id
    AND ae.invalidated_at IS NULL;

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
-- D57 followup form, with the gate on arena_wins. Everything else verbatim.
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

  -- A win has to be a standing measurement beating other standing
  -- measurements. Filtering only the candidate would leave a disqualified
  -- 1.000 setting a bar nothing valid could clear.
  SELECT COUNT(*) INTO v_arena_wins
  FROM arena_entries ae
  JOIN genes g ON ae.gene_id = g.id
  WHERE g.owner_id = p_user_id
    AND ae.invalidated_at IS NULL
    AND arena_entry_is_measured(ae.evaluation_method)
    AND ae.fitness_value = (
      SELECT MAX(ae2.fitness_value) FROM arena_entries ae2
       WHERE ae2.domain = ae.domain
         AND ae2.invalidated_at IS NULL
         AND arena_entry_is_measured(ae2.evaluation_method)
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

------------------------------------------------------------------------
-- Invalidation now reaches R(g) on its own
--
-- The existing triggers fire on arena_entries INSERT. Invalidation is an
-- UPDATE, so nothing recomputed when 57 rows were disqualified earlier
-- today — the criteria job wrote a timestamp and R(g) kept its old number
-- indefinitely. This closes that gap: the next time the job invalidates a
-- row, or clears its own invalidation, the gene's reputation follows without
-- anyone remembering to run something.
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_arena_invalidation_reputation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    PERFORM compute_gene_reputation(NEW.gene_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_arena_invalidation_reputation ON arena_entries;
CREATE TRIGGER trg_arena_invalidation_reputation
  AFTER UPDATE OF invalidated_at ON arena_entries
  FOR EACH ROW EXECUTE FUNCTION fn_arena_invalidation_reputation();

------------------------------------------------------------------------
-- The backfill, defined but NOT called
--
-- Deliberately not invoked by this migration. Restating 182 public numbers
-- is a data decision, not a schema one, and it should not ride along with a
-- formula change that happens to be queued at the same moment. Run it
-- explicitly:
--
--     SELECT recompute_all_published_reputation();
--
-- Idempotent and re-runnable. Returns how many genes and developers it
-- touched, so the caller gets a receipt rather than a silent success.
------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_all_published_reputation(
  OUT genes_recomputed INTEGER,
  OUT developers_recomputed INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  r RECORD;
BEGIN
  genes_recomputed := 0;
  developers_recomputed := 0;

  FOR r IN SELECT id FROM genes WHERE published = true LOOP
    PERFORM compute_gene_reputation(r.id);
    genes_recomputed := genes_recomputed + 1;
  END LOOP;

  FOR r IN SELECT DISTINCT owner_id FROM genes
            WHERE published = true AND owner_id IS NOT NULL LOOP
    PERFORM compute_developer_reputation(r.owner_id);
    developers_recomputed := developers_recomputed + 1;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION recompute_all_published_reputation() IS
  'One-time backfill after the R(g) gate landed (ADR-319 D4). Not called by its own migration on purpose: it restates a public number on every published gene, which is a data decision and needs its own authorisation. Idempotent.';

REVOKE ALL ON FUNCTION recompute_all_published_reputation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION arena_entry_is_measured(TEXT) TO anon, authenticated;
