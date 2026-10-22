-- ============================================================
-- An MCP call report is recorded under the account that sent it, and an
-- unsigned one is not counted (T-74; T-58 audit F5; T-72 review r2
-- condition 1, risks R1 and R3)
--
-- log_mcp_call() is granted to anon and authenticated and wrote whatever
-- p_caller it was given. Every row it writes bumps arena_entries.total_calls
-- for the gene it names (trg_update_arena_total_calls), and total_calls feeds
-- the Arena's stability score. So anyone holding the public anon key could
-- inflate any gene's call count — and the 10-per-minute limit was keyed on
-- the self-reported caller and tool name, so a new caller string or tool
-- name per request walked straight past it.
--
-- After this migration, for a client request (PostgREST roles
-- authenticated / anon):
--   * signed in: the caller recorded is auth.uid(). p_caller is ignored,
--     whatever it says — the same rule #438 applied to gene invocations
--     (ADR-319 D0).
--   * not signed in: the call is accepted and dropped — no mcp_call_log row,
--     so no total_calls. It does not raise, so an older MCP server (which
--     sends the anon key only) keeps working; its calls just stop counting.
-- service_role and server sessions are not clients: their p_caller is
-- recorded as given, as before.
--
-- The per-minute limit is now keyed on the recorded caller, and for a call
-- that names a gene, on (caller, gene) rather than (caller, tool name): one
-- account can add at most 10 calls a minute to one gene's total_calls,
-- however many tool names it cycles through. Without a gene it stays
-- (caller, tool name).
--
-- Order with T-67: T-67 revokes client SELECT on mcp_call_log and adds an
-- aggregate stats RPC. It does not touch this function, and this function
-- reads mcp_call_log as its owner, so the two can land in either order.
--
-- Additive per ADR-295: CREATE OR REPLACE with the same signature and grants.
-- No table, column or row changes.
-- ============================================================

CREATE OR REPLACE FUNCTION log_mcp_call(
  p_tool_name text,
  p_gene_id text DEFAULT NULL,
  p_success boolean DEFAULT true,
  p_latency_ms integer DEFAULT 0,
  p_caller text DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_caller text;
  v_recent_count integer;
BEGIN
  IF p_tool_name IS NULL OR trim(p_tool_name) = '' THEN
    RAISE EXCEPTION 'tool_name is required';
  END IF;

  p_latency_ms := LEAST(GREATEST(p_latency_ms, 0), 300000);

  -- SECURITY DEFINER changes the SQL identity, not the JWT: auth.role() and
  -- auth.uid() still describe the client.
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    IF auth.uid() IS NULL THEN
      -- Unsigned report: accepted, not recorded, not counted.
      RETURN;
    END IF;
    v_caller := auth.uid()::text;
  ELSE
    v_caller := p_caller;
  END IF;

  SELECT COUNT(*) INTO v_recent_count
  FROM mcp_call_log
  WHERE caller IS NOT DISTINCT FROM v_caller
    AND created_at > now() - interval '1 minute'
    AND CASE WHEN p_gene_id IS NOT NULL
             THEN gene_id = p_gene_id
             ELSE tool_name = p_tool_name END;

  IF v_recent_count >= 10 THEN
    RETURN;
  END IF;

  INSERT INTO mcp_call_log (tool_name, gene_id, success, latency_ms, caller)
  VALUES (p_tool_name, p_gene_id, p_success, p_latency_ms, v_caller);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION log_mcp_call(text, text, boolean, integer, text) IS
  'Records one MCP tool call. A signed-in client is recorded under auth.uid() whatever p_caller says; an unsigned client report is accepted and dropped (no row, so no arena_entries.total_calls). service_role passes p_caller through. At most 10 a minute per (caller, gene), or per (caller, tool) without a gene (T-74).';

REVOKE EXECUTE ON FUNCTION log_mcp_call(text, text, boolean, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_mcp_call(text, text, boolean, integer, text) TO anon, authenticated;
