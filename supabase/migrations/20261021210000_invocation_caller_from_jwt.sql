-- ============================================================
-- A client's invocation report is attributed to the client, not to whatever
-- name it sends (T-63; audit .agent-team/drafts/T-58-arena-rls-audit.md F2)
--
-- log_gene_invocation(_v2) is granted to authenticated, and took
-- p_caller_agent_id as free text. refresh_contribution_metrics() counts
-- unique_callers as COUNT(DISTINCT caller_agent_id), and §33.4's
-- self-invocation exclusion compares caller_agent_id with the gene's owner.
-- So one account could report a gene under several invented names and reach
-- the verified tier's minimum of unique callers, and an author could dodge
-- the self-invocation rule by not giving their own id.
--
-- ADR-319 D0: in v0.9 the caller granularity is the account,
-- caller_agent_id = owner id (AgentIdentity replaces it in v1.0). So for a
-- client request — PostgREST roles authenticated / anon — the server now
-- records auth.uid() as the caller, whatever was sent. A request in a client
-- role without a signed-in user is refused (42501): it names nobody.
-- service_role and server-side sessions (no client JWT) keep passing the
-- caller they choose.
--
-- Every current client already sends its own account id, the same token's
-- sub, so their reports are recorded exactly as before:
--   rotifer-playground CLI  src/cloud/invocation.ts  caller = credentials user.id
--   rotifer-mcp-server      src/server.ts → cloud.ts  caller = credentials user.id
-- (The chat Edge Function stopped reporting in 2026-08; no other repo calls
-- either function. rotifer-admin reads gene_invocation_log, never writes.)
--
-- anon cannot call either entry point (revoked in 20260322120000 and
-- 20260830000000), and gene_invocation_log refuses direct INSERTs from every
-- client role by policy (WITH CHECK (false)). The anon branch below is a
-- second line, not a path anyone uses.
--
-- Additive per ADR-295: log_gene_invocation_impl is replaced with the same
-- signature and the same idempotency guard; both entry points delegate to it,
-- so both are covered. No table, grant or row is changed.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION log_gene_invocation_impl(
  p_gene_id UUID,
  p_caller_agent_id TEXT,
  p_client_channel TEXT
)
RETURNS UUID AS $$
DECLARE
  v_id     UUID;
  v_caller TEXT := p_caller_agent_id;
BEGIN
  -- A client is the account its JWT belongs to (ADR-319 D0). The entry
  -- points are SECURITY DEFINER, which changes the SQL identity but not the
  -- request's JWT, so auth.role() / auth.uid() still describe the caller.
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION
        'log_gene_invocation: a client report needs a signed-in caller'
        USING ERRCODE = '42501';
    END IF;
    v_caller := auth.uid()::TEXT;
  END IF;

  -- ADR-322 D1's guard, unchanged, keyed on the recorded caller.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_gene_id::TEXT || ':' || v_caller, 0)
  );

  SELECT id INTO v_id
    FROM gene_invocation_log
   WHERE gene_id = p_gene_id
     AND caller_agent_id = v_caller
     AND invoked_at > now() - INTERVAL '5 seconds'
   ORDER BY invoked_at DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO gene_invocation_log (gene_id, caller_agent_id, client_channel)
  VALUES (p_gene_id, v_caller, p_client_channel)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION log_gene_invocation_impl(UUID, TEXT, TEXT) IS
  'Shared body for log_gene_invocation and log_gene_invocation_v2. A client request (authenticated/anon) is recorded under auth.uid(), whatever caller it names; one without a signed-in user is refused (T-63, ADR-319 D0). service_role and server sessions pass the caller through. Idempotent within 5 seconds per (gene, caller) — ADR-322 D1. Not granted to any client role.';

-- CREATE OR REPLACE keeps the existing grants; restated so this file alone
-- says who can reach it.
REVOKE EXECUTE ON FUNCTION log_gene_invocation_impl(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

COMMIT;
