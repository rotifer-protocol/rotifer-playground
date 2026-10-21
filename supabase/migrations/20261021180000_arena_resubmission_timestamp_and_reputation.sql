-- ============================================================
-- A re-submission to the Arena is an evaluation: it moves last_evaluated and
-- recomputes the gene's reputation.
--
-- Since #431 a second `arena submit` of a gene updates its row instead of
-- failing with 409. The update path was never exercised before, and two
-- things only ever happened on INSERT (found in T-55 acceptance):
--
-- 1. last_evaluated is a column DEFAULT, so it kept the first submission's
--    time. The leaderboard, gene detail and history views sort and show by
--    last_evaluated, so a re-submitted gene showed a new score with an old
--    date. updated_at moves (arena_updated_at) but means "any change".
--
-- 2. trg_arena_entry_reputation is AFTER INSERT only, so a new score never
--    reached gene_reputation / genes.reputation_score. Invalidation already
--    has its own UPDATE trigger (trg_arena_invalidation_reputation); this
--    adds the same for the score.
--
-- last_evaluated is stamped by the server, on writes made by a client
-- (PostgREST roles authenticated / anon) that set any of the columns a
-- submission writes. The time is the server's, so a client cannot backdate it.
-- Server-side writers — reset_season() scaling fitness_value by the retention
-- rate, the invalidation job, the total_calls trigger, backfills — are not
-- evaluations and do not move it; a future server-side evaluator sets
-- last_evaluated itself.
--
-- Reputation is recomputed whenever a column compute_gene_reputation reads
-- for the score actually changes (fitness_value, evaluation_method), from any
-- writer: a season reset that scales fitness should be reflected too.
-- total_calls is excluded — it changes on every invocation, and usage has its
-- own pipeline.
--
-- Additive per ADR-295: two functions, two triggers. Nothing existing is
-- altered or removed.
-- ============================================================

CREATE OR REPLACE FUNCTION stamp_arena_resubmission_time()
RETURNS TRIGGER AS $$
BEGIN
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    NEW.last_evaluated := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public, pg_temp;

COMMENT ON FUNCTION stamp_arena_resubmission_time() IS
  'A client re-submission (UPDATE of the submitted columns by authenticated/anon) is a new evaluation: last_evaluated becomes the server''s now(). Server-side updates are left alone.';

DROP TRIGGER IF EXISTS trg_stamp_arena_resubmission_time ON arena_entries;
CREATE TRIGGER trg_stamp_arena_resubmission_time
  BEFORE UPDATE OF fitness_value, base_fitness, fidelity_discount, safety_score, success_rate,
                   latency_score, resource_efficiency, evaluation_method, evaluation_n
  ON arena_entries
  FOR EACH ROW EXECUTE FUNCTION stamp_arena_resubmission_time();

-- Same body as the INSERT trigger's fn_arena_entry_reputation; a separate
-- trigger so the INSERT path is untouched.
DROP TRIGGER IF EXISTS trg_arena_entry_reputation_on_update ON arena_entries;
CREATE TRIGGER trg_arena_entry_reputation_on_update
  AFTER UPDATE OF fitness_value, evaluation_method ON arena_entries
  FOR EACH ROW
  WHEN (OLD.fitness_value IS DISTINCT FROM NEW.fitness_value
        OR OLD.evaluation_method IS DISTINCT FROM NEW.evaluation_method)
  EXECUTE FUNCTION fn_arena_entry_reputation();

-- Trigger functions are not callable as RPCs, but Postgres grants EXECUTE to
-- PUBLIC by default; state it.
REVOKE ALL ON FUNCTION stamp_arena_resubmission_time() FROM PUBLIC, anon, authenticated;
