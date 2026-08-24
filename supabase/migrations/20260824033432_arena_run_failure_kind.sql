-- plan 2.12 (arena-leaderboard-integrity): the run ledger could not tell "ran
-- out of a resource the evaluation rationed" from "crashed". The distinction
-- decides whether a failed run indicts the Gene or the evaluation design —
-- the evolve-life family failed admission purely on fuel, and the ledger
-- recorded it indistinguishably from a defect.
--
-- Additive only: one nullable column. NULL means "successful run" or "row
-- written before the column existed" — readers must not treat NULL as a kind.

ALTER TABLE arena_evaluation_runs
  ADD COLUMN IF NOT EXISTS failure_kind TEXT;

COMMENT ON COLUMN arena_evaluation_runs.failure_kind IS
  'Why a failed run failed, when the sandbox could say: fuel-exhausted | memory-exceeded | timeout | crash. NULL for successful runs and for rows predating the column. fuel-exhausted means the run died at the top of the evaluation fuel ladder - a resource ceiling, not necessarily a Gene defect (plan 2.12).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_arena_run_failure_kind'
      AND conrelid = 'arena_evaluation_runs'::regclass
  ) THEN
    ALTER TABLE arena_evaluation_runs
      ADD CONSTRAINT chk_arena_run_failure_kind CHECK (
        failure_kind IS NULL
        OR failure_kind IN ('fuel-exhausted', 'memory-exceeded', 'timeout', 'crash')
      );
  END IF;
END $$;
