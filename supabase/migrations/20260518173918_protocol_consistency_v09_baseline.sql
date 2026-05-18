-- Sprint C Phase 5 — protocol consistency forward-compat patch
--
-- Supersedes the never-applied 20260331120000_protocol_consistency_checks.sql
-- by extracting only the schema effects that are GENUINELY MISSING from v0.9
-- production (per MCP verification 2026-05-18). Sections of the original
-- file that overlap with already-applied work are SKIPPED.
--
-- MCP-verified pre-conditions (2026-05-18):
--   - mcp_call_log table exists ✓
--   - increment_arena_total_calls() function exists (from #1 already applied)
--     BUT no trigger wires it to mcp_call_log → there's no live mcp→arena
--     auto-increment. We add update_arena_total_calls() + trigger to fix this.
--   - check_prev_version_same_owner() + trg_genes_check_prev_version exist
--     and cover owner_id+name+previous_version_id consistency → original §2
--     (enforce_version_chain_name) is REDUNDANT and SKIPPED
--   - uq_owner_name_prev_version was DROPPED by #8 (CC1 repair-applied) →
--     original §3 is SKIPPED
--   - chk_gene_fidelity already exists with 3-value list ('Native','Wrapped',
--     'Hybrid'). Original §4a wants to widen to 4-value with 'Unknown' but
--     'Unknown' has no business need at v0.9 baseline → SKIPPED to keep
--     fidelity vocabulary tight
--   - chk_username_format already exists → §4b SKIPPED
--   - chk_arena_domain_format is MISSING. arena_entries has 0 rows that would
--     violate the regex → safe to add
--
-- Net effect: this migration adds (1) mcp→arena auto-increment trigger, and
-- (2) arena_entries.domain format CHECK. All other parts of the original
-- v0.8.1 protocol_consistency_checks file are absorbed/superseded.
--
-- Reference: meta-lesson S2-L11 (private; 2026-05-18; dev/prod parity sprint),
--            Sprint C plan §2 Phase 5

-- ═══════════════════════════════════════════════════════════════
-- 1. update_arena_total_calls — MCP call log → arena_entries auto-increment
--    Triggered AFTER INSERT on mcp_call_log
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_arena_total_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF NEW.gene_id IS NOT NULL THEN
    UPDATE arena_entries
    SET total_calls = total_calls + 1
    WHERE gene_id = NEW.gene_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_arena_total_calls ON public.mcp_call_log;
CREATE TRIGGER trg_update_arena_total_calls
  AFTER INSERT ON public.mcp_call_log
  FOR EACH ROW
  EXECUTE FUNCTION public.update_arena_total_calls();

-- ═══════════════════════════════════════════════════════════════
-- 2. chk_arena_domain_format — enforce lowercase dot-separated domain
--    Pre-verified MCP 2026-05-18: 0 arena_entries rows would violate.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_arena_domain_format'
      AND conrelid = 'public.arena_entries'::regclass
  ) THEN
    ALTER TABLE public.arena_entries
      ADD CONSTRAINT chk_arena_domain_format
      CHECK (domain ~ '^[a-z0-9]+(\.[a-z0-9]+)*$')
      NOT VALID;
    ALTER TABLE public.arena_entries VALIDATE CONSTRAINT chk_arena_domain_format;
  END IF;
END $$;
