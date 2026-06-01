-- ============================================================
-- Migration: Grant log_gene_invocation to authenticated role
-- Rotifer Protocol v0.9
--
-- §33.4 Anti-Manipulation requires MCP server to record gene
-- invocations with caller identity. MCP server authenticates
-- via OAuth (authenticated role), so needs EXECUTE permission.
-- ============================================================

BEGIN;

GRANT EXECUTE ON FUNCTION log_gene_invocation(UUID, TEXT) TO authenticated;

COMMIT;
