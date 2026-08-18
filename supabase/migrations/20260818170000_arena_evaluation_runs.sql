-- ============================================================
-- ADR-319 D3 / 专项阶段 2.3: the evidence behind a score
--
-- An Arena row states F(g) and V(g). Nothing behind it is recorded, so
-- "recompute the rankings yourself" — which §9.7.1 promises and ADR-319's
-- whole argument rests on — is not actually possible. A third party can read
-- the conclusion and has no way to check it.
--
-- This table holds the per-run measurements a submission was computed from,
-- publicly readable, append-only. With it, anyone can apply the ADR-318
-- formula to the same inputs and see whether they get the same answer.
--
-- Two design choices worth stating:
--
-- sandbox_success and output_schema_valid are SEPARATE columns. The CLI
-- collapses them into one boolean before computing S_r (a run counts only if
-- the sandbox succeeded AND the output honoured the Gene's own outputSchema —
-- 1.5 / playground#182). Collapsing is right for the score and wrong for the
-- ledger: "ran but returned garbage" and "crashed" are different failures, and
-- a reader who cannot tell them apart cannot diagnose a Gene or audit the
-- rule. NULL in output_schema_valid means the Gene declared no usable schema,
-- which is itself worth knowing.
--
-- Rows are never updated or deleted. An evaluation that happened, happened;
-- superseding it means adding a newer submission, not editing the old one.
-- RLS enforces this — there is no UPDATE or DELETE policy at all.
--
-- Additive per ADR-295: one new table. Nothing existing is touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS arena_evaluation_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gene_id             UUID NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
  -- Groups the runs of one submission. Client-generated: it only has to be
  -- unique, not unguessable, and the server has nothing better to offer
  -- before the rows arrive.
  submission_id       UUID NOT NULL,
  run_index           INTEGER NOT NULL,
  sandbox_success     BOOLEAN NOT NULL,
  -- NULL = the Gene declared no usable outputSchema, so there was nothing to
  -- validate against. Do not read NULL as "passed".
  output_schema_valid BOOLEAN,
  latency_ms          DOUBLE PRECISION NOT NULL,
  resource_cost       DOUBLE PRECISION NOT NULL,
  evaluator           TEXT,
  evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_arena_run           UNIQUE (submission_id, run_index),
  CONSTRAINT chk_arena_run_index    CHECK (run_index >= 0),
  CONSTRAINT chk_arena_run_latency  CHECK (latency_ms >= 0),
  CONSTRAINT chk_arena_run_cost     CHECK (resource_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_arena_runs_gene_time
  ON arena_evaluation_runs(gene_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_runs_submission
  ON arena_evaluation_runs(submission_id);

ALTER TABLE arena_evaluation_runs ENABLE ROW LEVEL SECURITY;

-- §9.7.1: the evidence is public, or the promise to recompute is empty.
DROP POLICY IF EXISTS "Evaluation runs are publicly readable" ON arena_evaluation_runs;
CREATE POLICY "Evaluation runs are publicly readable"
  ON arena_evaluation_runs FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Signed-in callers may record evaluation runs" ON arena_evaluation_runs;
CREATE POLICY "Signed-in callers may record evaluation runs"
  ON arena_evaluation_runs FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- No UPDATE and no DELETE policy, deliberately. Append-only: a measurement
-- that was taken cannot be revised, only superseded by a later submission.
--
-- And belt as well as braces. Supabase grants every table privilege to anon
-- and authenticated by default, leaving RLS as the only thing between a
-- client and `DELETE FROM arena_evaluation_runs`. For an append-only ledger
-- that is one layer too few: revoke the privileges outright, so the evidence
-- survives even a future migration that disables RLS by accident.
REVOKE UPDATE, DELETE, TRUNCATE ON arena_evaluation_runs FROM anon, authenticated;
REVOKE INSERT ON arena_evaluation_runs FROM anon;

-- Same rule as arena_entries: who measured this is not the measurer's to claim.
CREATE OR REPLACE FUNCTION stamp_evaluation_run_evaluator()
RETURNS TRIGGER AS $$
BEGIN
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') AND auth.uid() IS NOT NULL THEN
    NEW.evaluator := auth.uid()::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_stamp_evaluation_run_evaluator ON arena_evaluation_runs;
CREATE TRIGGER trg_stamp_evaluation_run_evaluator
  BEFORE INSERT ON arena_evaluation_runs
  FOR EACH ROW
  EXECUTE FUNCTION stamp_evaluation_run_evaluator();

COMMENT ON TABLE arena_evaluation_runs IS
  'Per-run measurements behind an Arena submission (ADR-319 D3). Public and append-only so third parties can recompute F(g) per ADR-318 rather than take the score on trust.';
COMMENT ON COLUMN arena_evaluation_runs.output_schema_valid IS
  'Whether the run output satisfied the Gene''s declared outputSchema. NULL = no usable schema was declared; do not read NULL as passed.';
