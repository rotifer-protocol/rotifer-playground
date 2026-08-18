-- ============================================================
-- ADR-319 D2 / 专项阶段 2.1: provenance and invalidation become
-- first-class columns on arena_entries
--
-- Today an Arena row carries five numbers and no answer to "where did these
-- come from". A score measured in a sandbox, a score estimated from a hash,
-- and a score typed in by hand through the MCP tool are stored identically
-- and rank against each other. That is the defect ADR-319 D3 names: scores
-- are self-reported and the server cannot tell them apart.
--
-- This migration adds the columns. It deliberately does NOT change any
-- ranking behaviour — writers (2.2) and the reproducible invalidation
-- criteria (2.5) come next, and the three-tier board (3.1) after that. Adding
-- the vocabulary first means those can land independently.
--
-- Design note on the default. `evaluation_method` is NOT NULL DEFAULT
-- 'unknown-legacy', not nullable:
--   - the 104 existing rows genuinely are unknown provenance, and saying so
--     is more honest than NULL;
--   - a future writer that forgets to declare a method lands in
--     'unknown-legacy', which per D2 does not participate in ranking. Failing
--     to say how you measured something costs you your rank rather than
--     silently granting one. It fails closed.
--
-- Additive per ADR-295: five ADD COLUMN, two CHECK constraints on the new
-- columns, one partial index. No existing column is dropped, retyped or
-- re-constrained; no row is deleted; no score is touched. Re-runnable.
-- ============================================================

ALTER TABLE arena_entries
  ADD COLUMN IF NOT EXISTS evaluation_method   TEXT NOT NULL DEFAULT 'unknown-legacy',
  ADD COLUMN IF NOT EXISTS evaluation_n        INTEGER,
  ADD COLUMN IF NOT EXISTS evaluator           TEXT,
  ADD COLUMN IF NOT EXISTS invalidated_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidation_reason TEXT;

DO $$
BEGIN
  -- Closed vocabulary. `binding_runtime` is reserved for the server to assign
  -- (ADR-319 D2: "客户端不得自选 binding_runtime") — the constraint cannot
  -- enforce who writes it, so 2.2 must judge that by the authenticated
  -- principal. The constraint only stops values nobody defined.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_evaluation_method') THEN
    ALTER TABLE arena_entries ADD CONSTRAINT chk_arena_evaluation_method
      CHECK (evaluation_method IN ('sandbox', 'estimated', 'declared', 'binding_runtime', 'unknown-legacy'));
  END IF;

  -- An invalidation without a reason is exactly the "someone reached in and
  -- changed a rank" that ADR-319 D6 forbids. Keep the pair inseparable at the
  -- schema level so no code path can produce a half-invalidation.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_invalidation_pair') THEN
    ALTER TABLE arena_entries ADD CONSTRAINT chk_arena_invalidation_pair
      CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_evaluation_n') THEN
    ALTER TABLE arena_entries ADD CONSTRAINT chk_arena_evaluation_n
      CHECK (evaluation_n IS NULL OR evaluation_n >= 0);
  END IF;
END $$;

-- The ranking query will filter out invalidated rows; the existing
-- idx_arena_fitness(domain, fitness_value DESC) does not know about them.
CREATE INDEX IF NOT EXISTS idx_arena_rankable
  ON arena_entries(domain, fitness_value DESC)
  WHERE invalidated_at IS NULL;

COMMENT ON COLUMN arena_entries.evaluation_method IS
  'How the scores on this row were obtained. sandbox = measured locally by the CLI; estimated = derived without running; declared = supplied verbatim by a client (legacy MCP arena_submit); binding_runtime = measured server-side, assigned by the server only; unknown-legacy = predates provenance tracking. Per ADR-319 D2 only measured methods rank.';
COMMENT ON COLUMN arena_entries.evaluation_n IS
  'Number of runs behind the scores (ADR-318 D5). NULL when unknown — do not read NULL as 1.';
COMMENT ON COLUMN arena_entries.evaluator IS
  'Who measured: Cloud account, AgentDID, or binding:<id>. NULL for legacy rows.';
COMMENT ON COLUMN arena_entries.invalidated_at IS
  'Set when a reproducible, publicly documented criterion invalidated this row (ADR-319 D2). Rows are never deleted. Always paired with invalidation_reason.';
COMMENT ON COLUMN arena_entries.invalidation_reason IS
  'Machine-readable criterion id, e.g. async-express-artifact, test-data. Must name a published criterion — never a one-off human judgement (ADR-319 D6).';
