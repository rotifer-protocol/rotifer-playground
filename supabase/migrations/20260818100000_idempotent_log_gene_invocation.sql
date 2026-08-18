-- ============================================================
-- ADR-322 D1: write-layer idempotency for log_gene_invocation
--
-- One user action was being recorded twice. The MCP server's `run_gene` does
-- not execute a Gene itself — it shells out to the CLI (mcp-server
-- src/local.ts runGene -> rotiferCmd). Since playground v0.12.0 the spawned
-- CLI reports its own invocation, and the MCP server then reports again:
-- two rows in gene_invocation_log for a single call.
--
-- Whether it happens depends on the user's machine. resolveRotiferBin() runs
-- `which rotifer` first and falls back to `npx -y @rotifer/playground`
-- (unpinned, so always latest). A developer with an old global CLI installed
-- sees one row and notices nothing; the typical MCP user — Cursor or Claude
-- Code, no global CLI — gets latest from npx and two rows every time.
--
-- Today the duplicate does not reach the aggregates: refresh_contribution_
-- metrics() keeps only daily_rank = 1 per caller-gene per day, so the pair
-- collapses. That is luck, not design, and it is not a reason to leave it:
-- §9.7.1 promises the *raw* ledger is publicly recomputable, and the rule
-- currently hiding the duplicate is one this project has already flagged as
-- deviating from the spec's recommended window. A defect masked by a rule we
-- intend to correct is a defect waiting to reappear.
--
-- This is the write layer. It is NOT a substitute for §33.4 Rule 4 (aggregate
-- dedup): that one stops a caller from inflating counts over hours; this one
-- stops a single call from being written twice. Different layers, different
-- jobs, both needed.
--
-- Window: 5 seconds. Rationale lives in ADR-322 D1 rather than in this file,
-- but in short — far longer than the MCP -> CLI hand-off (milliseconds to a
-- cold npx start), far shorter than any genuine repeat call by a human or an
-- agent. If it ever swallows a real invocation, adjust it in the ADR first.
--
-- Idempotent + additive: CREATE OR REPLACE on one function. No schema change,
-- no data touched, existing rows untouched (ADR-322 D4 — the duplicates
-- already in the ledger are not cleaned by hand; they go through the
-- reproducible invalidation criteria like everything else).
-- ============================================================

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
     AND invoked_at > now() - INTERVAL '5 seconds'
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
  'Records one Gene invocation. Idempotent within 5 seconds per (gene, caller) — ADR-322 D1: the MCP server and the CLI it spawns both report the same call.';
