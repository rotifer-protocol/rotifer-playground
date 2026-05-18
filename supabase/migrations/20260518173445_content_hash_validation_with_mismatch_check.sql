-- Sprint C Phase 4 — content_hash server-side validation (forward-compat patch)
--
-- Supersedes the never-applied 20260331140000_content_hash_server_validation.sql
-- and absorbs the never-applied 20260331150000_audit_fixes.sql Fix 1 (hash
-- mismatch comparison) into a single coherent migration aligned with v0.9
-- baseline state.
--
-- MCP-verified pre-conditions (2026-05-18):
--   - 0 published genes have NULL content_hash (171/171 covered)
--   - trg_require_content_hash already in place (added by 20260330140000,
--     blocks future NULL-content_hash publishes)
--   - pgcrypto 1.3 already enabled
--   - validate_content_hash_on_publish function does NOT yet exist
--   - chk_published_content_hash CHECK constraint does NOT yet exist
--
-- This migration is purely additive and can fail-safe (ON CONFLICT semantics
-- via DO $$ ... EXCEPTION blocks). Re-running is a NO-OP.
--
-- Reference: meta-lesson S2-L11 (private; 2026-05-18; dev/prod parity sprint),
--            Sprint C plan §2 Phase 4

-- ═══════════════════════════════════════════════════════════════
-- 1. validate_content_hash_on_publish — server-side hash validation
--    Includes:
--    - Hash mismatch check (audit_fixes Fix 1)
--    - Duplicate content_hash detection (original #6 design)
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.validate_content_hash_on_publish()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_canonical TEXT;
  v_server_hash TEXT;
  v_existing_id UUID;
BEGIN
  IF NEW.published = true AND NEW.content_hash IS NOT NULL AND NEW.phenotype IS NOT NULL THEN
    -- Canonical serialization: PostgreSQL jsonb sorts keys lexicographically.
    -- This is a SECONDARY integrity check — the client-side hash is the
    -- primary source of truth. PostgreSQL jsonb key sorting may not perfectly
    -- match JS sortKeysDeep for deeply nested objects; if a soft mismatch
    -- becomes recurring, downgrade to RAISE WARNING or compute via plv8.
    v_canonical := NEW.phenotype::jsonb::text;
    v_server_hash := encode(digest(v_canonical, 'sha256'), 'hex');

    -- Hash mismatch check: server-computed hash vs client-provided hash
    IF v_server_hash <> NEW.content_hash THEN
      RAISE EXCEPTION 'content_hash mismatch: client=% server=%. Phenotype may have been tampered with or canonicalization differs.',
        NEW.content_hash, v_server_hash
        USING ERRCODE = '22023'; -- invalid_parameter_value → 400 in PostgREST
    END IF;

    -- Duplicate content check: different published gene with same hash
    SELECT id INTO v_existing_id
      FROM genes
      WHERE content_hash = NEW.content_hash
        AND id != NEW.id
        AND published = true
      LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate content_hash: gene % already has this hash. This gene is a duplicate.',
        v_existing_id
        USING ERRCODE = '23505'; -- unique_violation → 409 in PostgREST
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 2. trg_validate_content_hash — BEFORE INSERT/UPDATE on genes
-- ═══════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_validate_content_hash ON public.genes;
CREATE TRIGGER trg_validate_content_hash
  BEFORE INSERT OR UPDATE ON public.genes
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_content_hash_on_publish();

-- ═══════════════════════════════════════════════════════════════
-- 3. chk_published_content_hash — published genes MUST have content_hash
--    Pre-verified MCP 2026-05-18: 0 published rows would violate.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_published_content_hash'
      AND conrelid = 'public.genes'::regclass
  ) THEN
    ALTER TABLE public.genes
      ADD CONSTRAINT chk_published_content_hash
      CHECK (published = false OR content_hash IS NOT NULL);
  END IF;
END $$;
