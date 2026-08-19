-- ============================================================
-- ADR-322 D3: recurrence probe for double-reported invocations
--
-- D1 stopped one user action being written twice. D3 exists because the
-- defect survived for months not by being subtle but by nobody looking: if
-- the guard regresses, or a new client reports in a way it does not cover,
-- the only signal would again be a ledger quietly counting one call as two.
--
-- What this publishes is the *evidence*, not a verdict: every pair of
-- consecutive rows for the same (gene, caller) that sit closer together than
-- the dedup window. Under a working guard that set is empty for anything the
-- guard governed.
--
-- Two things this migration is careful about.
--
-- 1. The window is defined once. D1 wrote `INTERVAL '5 seconds'` inline. A
--    probe that restated the same number would agree with the guard only
--    until someone tuned one of them, and then would report zero while
--    duplicates flowed — a probe that lies is worse than none. So the window
--    moves into `invocation_dedup_window()` and both read it.
--
-- 2. Pre-guard duplicates are labelled, not hidden and not cleaned. Two pairs
--    already exist in production, written at 05:03 on 2026-08-18, hours
--    before D1 reached the database at 10:00. ADR-322 D4 says they stay: they
--    are real history, and hand-editing the ledger is exactly what D6 of
--    ADR-319 forbids. But a probe that counted them would be permanently red,
--    and a permanently red probe teaches everyone to ignore it. So the view
--    carries `after_guard`, and the alarm reads only that side while the
--    history stays visible next to it.
--
-- Additive: two new functions, one new view. No table, no column, no data
-- touched (ADR-295).
-- ============================================================

-- ── The dedup window, in one place ──────────────────────────

CREATE OR REPLACE FUNCTION invocation_dedup_window()
RETURNS INTERVAL
LANGUAGE sql IMMUTABLE
SET search_path = 'public'
AS $$ SELECT INTERVAL '5 seconds' $$;

COMMENT ON FUNCTION invocation_dedup_window() IS
  'Write-layer dedup window for gene invocations (ADR-322 D1). Read by both log_gene_invocation and gene_invocation_duplicate_probe so the guard and the probe that checks it can never disagree. Rationale for the value lives in ADR-322 D1.';

/**
 * When the D1 guard reached production.
 *
 * Duplicates written before this instant are history the guard never had a
 * chance to prevent; duplicates after it are a regression. Stated as a
 * function rather than inlined in the view so the distinction has a name and
 * one definition.
 */
CREATE OR REPLACE FUNCTION invocation_dedup_guard_since()
RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE
SET search_path = 'public'
AS $$ SELECT TIMESTAMPTZ '2026-08-18 10:00:00+00' $$;

COMMENT ON FUNCTION invocation_dedup_guard_since() IS
  'Instant migration 20260818100000 (ADR-322 D1) reached production. Separates duplicates the guard could have prevented from the two pre-guard pairs ADR-322 D4 keeps.';

-- ── The guard now reads the shared window ───────────────────

CREATE OR REPLACE FUNCTION log_gene_invocation(
  p_gene_id UUID,
  p_caller_agent_id TEXT
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Serialise concurrent reports for the same caller-gene pair, so the
  -- check-then-insert below cannot be raced. Today's duplicate arrives
  -- sequentially (the MCP server reports after the CLI it spawned has
  -- returned), but a future client could report in parallel, and an
  -- idempotency guard that only holds when nobody is concurrent is not one.
  -- Transaction-scoped: released at commit, no explicit unlock needed.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_gene_id::TEXT || ':' || p_caller_agent_id, 0)
  );

  SELECT id INTO v_id
    FROM gene_invocation_log
   WHERE gene_id = p_gene_id
     AND caller_agent_id = p_caller_agent_id
     AND invoked_at > now() - invocation_dedup_window()
   ORDER BY invoked_at DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Already recorded. Hand back the row that represents this call rather
    -- than NULL: the caller asked for its invocation to be logged, and it is.
    -- Returning NULL would read as a failure and invite a retry, which is the
    -- opposite of what this function is for.
    RETURN v_id;
  END IF;

  INSERT INTO gene_invocation_log (gene_id, caller_agent_id)
  VALUES (p_gene_id, p_caller_agent_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION log_gene_invocation(UUID, TEXT) IS
  'Records one Gene invocation. Idempotent within invocation_dedup_window() per (gene, caller) — ADR-322 D1: the MCP server and the CLI it spawns both report the same call.';

-- ── The probe ───────────────────────────────────────────────

/**
 * Consecutive invocations of the same gene by the same caller that landed
 * closer together than the dedup window — i.e. rows the guard should have
 * collapsed into one.
 *
 * `security_invoker` so the view is read under the caller's own privileges
 * rather than the owner's. `gene_invocation_log` is publicly readable by
 * policy (§9.7.1), so this changes nothing today; it is set because a view
 * that silently bypasses RLS is a liability the moment the underlying policy
 * tightens.
 */
CREATE OR REPLACE VIEW gene_invocation_duplicate_probe
WITH (security_invoker = true) AS
SELECT
  gene_id,
  caller_agent_id,
  previous_invoked_at,
  invoked_at,
  invoked_at - previous_invoked_at AS gap,
  invoked_at >= invocation_dedup_guard_since() AS after_guard
FROM (
  SELECT
    gene_id,
    caller_agent_id,
    invoked_at,
    LAG(invoked_at) OVER (
      PARTITION BY gene_id, caller_agent_id
      ORDER BY invoked_at
    ) AS previous_invoked_at
  FROM gene_invocation_log
) AS ordered
WHERE previous_invoked_at IS NOT NULL
  AND invoked_at - previous_invoked_at < invocation_dedup_window();

COMMENT ON VIEW gene_invocation_duplicate_probe IS
  'ADR-322 D3: pairs of consecutive same-(gene,caller) invocations closer than invocation_dedup_window(). Rows with after_guard = true are a regression and must be zero; after_guard = false are the pre-D1 pairs ADR-322 D4 deliberately keeps.';

GRANT SELECT ON gene_invocation_duplicate_probe TO anon, authenticated;
