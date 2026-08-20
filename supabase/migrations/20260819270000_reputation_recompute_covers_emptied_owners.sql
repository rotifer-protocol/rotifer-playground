-- ============================================================
-- ADR-323 follow-up — an owner who loses every gene keeps a stale score
--
-- `recompute_all_published_reputation()` iterates
--   SELECT DISTINCT owner_id FROM genes WHERE published = true
-- which is every owner who *currently has* a published gene. An owner who had
-- one and no longer does is not in that set, so nothing recomputes them and
-- whatever score they last held stays written.
--
-- That is not hypothetical. The ADR-323 ownership move emptied
-- `rotifer-protocol-legacy` completely, and the creators leaderboard came out
-- of it showing two entries at 0.1324 — the live identity, correctly, and a
-- ghost that owns nothing. A leaderboard that keeps paying out to an identity
-- with no genes is the same class of defect as the board that kept ranking
-- invalidated rows: the read path reflects a state the data no longer supports.
--
-- The fix is to iterate over everyone who has a reputation row, union everyone
-- who owns a published gene. The first set catches identities that emptied
-- out; the second catches identities that have genes but no reputation row
-- yet. Neither alone is sufficient.
--
-- Idempotent, and re-run here so the ghost is cleared rather than waiting for
-- the next time someone calls it.
--
-- Additive per ADR-295: CREATE OR REPLACE on one function.
-- ============================================================

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

  -- Everyone with a score on file, plus everyone who owns something. An owner
  -- who lost their last gene is only in the first set, and they are precisely
  -- the ones whose stored score is now wrong.
  FOR r IN
    SELECT user_id AS owner_id FROM developer_reputation
    UNION
    SELECT owner_id FROM genes WHERE published = true AND owner_id IS NOT NULL
  LOOP
    PERFORM compute_developer_reputation(r.owner_id);
    developers_recomputed := developers_recomputed + 1;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION recompute_all_published_reputation() IS
  'One-time/idempotent reputation backfill (ADR-319 D4). Iterates every owner with a reputation row as well as every owner of a published gene — an owner who loses their last gene would otherwise never be recomputed and would keep a stale score on the creators leaderboard (found after the ADR-323 ownership move).';

REVOKE ALL ON FUNCTION recompute_all_published_reputation() FROM PUBLIC, anon, authenticated;

-- Clear the ghost the ADR-323 move left behind.
DO $$
DECLARE
  v_devs INTEGER;
BEGIN
  SELECT developers_recomputed INTO v_devs FROM recompute_all_published_reputation();
  RAISE NOTICE 'ADR-323 follow-up: recomputed % developers, including any now holding no genes', v_devs;
END;
$$;
