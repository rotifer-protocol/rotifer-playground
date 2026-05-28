-- ============================================================
-- Migration: Fix digest() schema resolution in validate_content_hash_on_publish
-- Rotifer Protocol — hotfix for GitHub Issue #50 Bug 1
--
-- Symptom: All `rotifer publish` calls fail with
--   "function digest(text, unknown) does not exist"
--
-- Root cause:
--   - pgcrypto is installed in `extensions` schema (Supabase default)
--   - validate_content_hash_on_publish has SET search_path = 'public'
--     which overrides the session default ("$user, public, extensions")
--   - PG cannot find digest() in public schema → trigger fails on every
--     INSERT/UPDATE of genes table where published = true
--
-- Verified via Supabase MCP (2026-05-28):
--   - pgcrypto.extversion = 1.3, schema = extensions
--   - digest(bytea|text, text) functions live in extensions schema
--   - 0 successful publishes since trigger migration 2026-05-18 17:34:45
--   - DO block in same `SET search_path = 'public'` context reproduces
--     the exact "(text, unknown)" error verbatim
--   - extensions.digest(::bytea, ::text) in same context succeeds
--
-- Fix: schema-qualify the digest() call as extensions.digest(::bytea, ::text).
-- This is Supabase's recommended pattern (per their lint advisor) over
-- broadening search_path to include `extensions`, because it prevents
-- a future public.digest() from silently hijacking the call.
--
-- Safety: this is a CREATE OR REPLACE FUNCTION on a trigger function.
-- PostgreSQL DDL is atomic — old function body is replaced in a single
-- transaction. No data is touched. The trigger attachment is unchanged.
-- ============================================================

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

    -- ⬇️ Fix Issue #50 Bug 1: schema-qualify digest() + explicit casts.
    -- The function-local `SET search_path = 'public'` excludes the
    -- `extensions` schema where pgcrypto lives, so we must call it
    -- by its fully-qualified name.
    v_server_hash := encode(
      extensions.digest(v_canonical::bytea, 'sha256'::text),
      'hex'
    );

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
