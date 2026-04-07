-- Protocol Consistency & CHECK Constraints
-- §3.12 P1#9: total_calls server-side trigger
-- §3.13 P1#7: version chain name consistency
-- §3.13 P1#8: version chain fork prevention UNIQUE
-- §3.14 P1#15: CHECK constraints (fidelity, name, username, domain)

-- ============================================================
-- 1. total_calls auto-increment trigger (§3.12 P1#9)
--    Arena total_calls should be managed server-side based on
--    actual MCP call log entries, not client-submitted values.
-- ============================================================

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

DROP TRIGGER IF EXISTS trg_update_arena_total_calls ON mcp_call_log;
CREATE TRIGGER trg_update_arena_total_calls
  AFTER INSERT ON mcp_call_log
  FOR EACH ROW
  EXECUTE FUNCTION public.update_arena_total_calls();

-- ============================================================
-- 2. Version chain name consistency trigger (§3.13 P1#7)
--    Prevent cross-gene version chain linking.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_version_chain_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  prev_name text;
BEGIN
  IF NEW.previous_version_id IS NOT NULL THEN
    SELECT name INTO prev_name
    FROM genes
    WHERE id = NEW.previous_version_id;

    IF prev_name IS NOT NULL AND prev_name <> NEW.name THEN
      RAISE EXCEPTION 'Version chain name mismatch: gene "%" cannot link to previous version with name "%"',
        NEW.name, prev_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_version_chain_name ON genes;
CREATE TRIGGER trg_enforce_version_chain_name
  BEFORE INSERT ON genes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_version_chain_name();

-- ============================================================
-- 3. Version chain fork prevention (§3.13 P1#8)
--    Same owner cannot create two genes forking from the same
--    previous_version_id (linear version chain per owner).
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_owner_name_prev_version'
  ) THEN
    ALTER TABLE genes
    ADD CONSTRAINT uq_owner_name_prev_version
    UNIQUE (owner_id, name, previous_version_id);
  END IF;
END $$;

-- ============================================================
-- 4. CHECK constraints (§3.14 P1#15)
-- ============================================================

-- 4a. genes.fidelity enum constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_gene_fidelity'
  ) THEN
    ALTER TABLE genes
    ADD CONSTRAINT chk_gene_fidelity
    CHECK (fidelity IN ('Native', 'Wrapped', 'Hybrid', 'Unknown'))
    NOT VALID;
    ALTER TABLE genes VALIDATE CONSTRAINT chk_gene_fidelity;
  END IF;
END $$;

-- 4b. profiles.username format constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_username_format'
  ) THEN
    ALTER TABLE profiles
    ADD CONSTRAINT chk_username_format
    CHECK (username ~ '^[a-zA-Z0-9_-]{1,39}$')
    NOT VALID;
    ALTER TABLE profiles VALIDATE CONSTRAINT chk_username_format;
  END IF;
END $$;

-- 4c. arena_entries.domain format constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_arena_domain_format'
  ) THEN
    ALTER TABLE arena_entries
    ADD CONSTRAINT chk_arena_domain_format
    CHECK (domain ~ '^[a-z0-9]+(\.[a-z0-9]+)*$')
    NOT VALID;
    ALTER TABLE arena_entries VALIDATE CONSTRAINT chk_arena_domain_format;
  END IF;
END $$;
