-- ============================================================
-- Migration 006: Revoke anon EXECUTE on restricted functions
-- Rotifer Protocol v0.7
--
-- In Supabase, the `anon` role has explicit GRANT separate
-- from PUBLIC. REVOKE FROM PUBLIC alone does not remove
-- the anon grant. This migration explicitly revokes anon
-- access on functions that should be restricted.
-- ============================================================

BEGIN;

-- apply_reputation_decay: only service_role (cron/admin)
REVOKE EXECUTE ON FUNCTION apply_reputation_decay() FROM anon;

-- compute_gene_reputation: only authenticated users
REVOKE EXECUTE ON FUNCTION compute_gene_reputation(UUID) FROM anon;

-- compute_developer_reputation: only authenticated users
REVOKE EXECUTE ON FUNCTION compute_developer_reputation(UUID) FROM anon;

COMMIT;
