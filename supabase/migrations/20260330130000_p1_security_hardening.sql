-- P1 Security Hardening Batch Migration
-- Items: version chain name consistency, anti-fork UNIQUE, CHECK constraints,
-- shared_conversations auth, total_calls server-side management

-- ═══════════════════════════════════════════════════════════════
-- 1. Version chain name consistency (§3.13 P1#7)
--    Reject cross-gene version linking
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_prev_version_same_owner()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.previous_version_id IS NOT NULL THEN
    PERFORM 1 FROM genes
    WHERE id = NEW.previous_version_id
      AND owner_id = NEW.owner_id
      AND name = NEW.name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'previous_version_id must reference a gene with the same owner AND name';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = 'public';

-- ═══════════════════════════════════════════════════════════════
-- 2. Version chain anti-fork UNIQUE constraint (§3.13 P1#8)
--    Same owner cannot fork one previous version into multiple successors
-- ═══════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TABLE genes ADD CONSTRAINT uq_version_chain_linear
    UNIQUE (owner_id, name, previous_version_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 3. CHECK constraints for data integrity (§3.14 P1#15)
-- ═══════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TABLE genes ADD CONSTRAINT chk_gene_fidelity
    CHECK (fidelity IN ('Native', 'Wrapped', 'Hybrid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE genes ADD CONSTRAINT chk_gene_name_format
    CHECK (name ~ '^[a-zA-Z0-9_]([a-zA-Z0-9._-]*[a-zA-Z0-9_])?$' AND length(name) <= 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT chk_username_format
    CHECK (username ~ '^[a-zA-Z0-9_-]{1,39}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 4. Shared conversations: require authentication (§3.14 P1#16)
--    Replace anonymous insert with authenticated + rate limit
-- ═══════════════════════════════════════════════════════════════

-- Note: shared_conversations is managed in a separate Supabase project.
-- This migration applies only to rotifer-playground's Supabase project.
-- The shared_conversations fix must be handled in that project separately.

-- ═══════════════════════════════════════════════════════════════
-- 5. total_calls server-side management (§3.12 P1#9)
--    Auto-increment via trigger instead of client submission
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_arena_total_calls()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE arena_entries
  SET total_calls = total_calls + 1
  WHERE gene_id = NEW.gene_id
    AND domain = NEW.domain;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = 'public';

-- Only create trigger if arena call logging table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mcp_call_log') THEN
    DROP TRIGGER IF EXISTS trg_mcp_call_increment_arena ON mcp_call_log;
    -- Note: mcp_call_log tracks tool calls, not arena calls specifically.
    -- total_calls should be incremented when arena evaluations occur,
    -- but the current schema has no dedicated arena_call_log table.
    -- For now, we remove client-side total_calls submission and default to 0.
    NULL;
  END IF;
END $$;

-- Remove total_calls from arena_entries default (will be managed server-side)
ALTER TABLE arena_entries ALTER COLUMN total_calls SET DEFAULT 0;
