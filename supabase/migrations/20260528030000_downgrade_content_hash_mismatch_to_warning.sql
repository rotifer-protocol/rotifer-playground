-- ============================================================
-- Migration: Downgrade content_hash mismatch from EXCEPTION to WARNING
-- Rotifer Protocol — hotfix part 2 for GitHub Issue #50 Bug 1
--
-- Symptom (after 20260528020000 fix landed):
--   - `digest does not exist` is gone (Bug 1 root cause fixed)
--   - But trigger now raises `content_hash mismatch: client=X server=Y`
--     on EVERY publish, because the client-side and server-side hash
--     algorithms disagree
--
-- Root cause (verified via Supabase MCP 2026-05-28):
--   - Client (src/utils/content-hash.ts) uses:
--       JSON.stringify(sortKeysDeep(phenotype))
--       → compact (no spaces) + alphabetical key order
--   - Server (phenotype::jsonb::text) emits:
--       {"k": "v", ...}
--       → spaces after commas/colons + jsonb internal binary order
--         (NOT alphabetical)
--   - Two strings are inherently different → SHA256 will never match
--   - All 171 published genes: 0 / 171 stored_hash == server_recompute
--
-- The migration that introduced this trigger (20260518173445) had a
-- comment that explicitly anticipated this risk and recommended the
-- WARNING fallback:
--
--   "PostgreSQL jsonb key sorting may not perfectly match JS sortKeysDeep
--    for deeply nested objects; if a soft mismatch becomes recurring,
--    downgrade to RAISE WARNING or compute via plv8."
--
-- Decision (Issue #50 short-term hotfix; tracked in ADR-292):
--   - Mismatch check: RAISE EXCEPTION → RAISE WARNING
--     (server still logs the discrepancy for audit, but does not block)
--   - Duplicate content_hash check: KEEP as EXCEPTION
--     (this is independent of hash-algorithm parity; still defends spam)
--
-- Long-term root fix (deferred to v0.9 follow-up sprint, ADR-292):
--   Align client and server canonical-serialization algorithms.
--   Two candidate paths:
--     (a) Server-side plv8/plpgsql canonical serializer matching JS
--     (b) Client switches to a serializer mimicking PG jsonb::text
--     (c) Drop server-side recompute entirely; trust signed client hash
--   To be evaluated when sprint opens.
--
-- Safety: this is a CREATE OR REPLACE on a trigger function.
-- Atomic DDL. No data touched. Trigger attachment unchanged.
-- Duplicate detection (the security-relevant arm) is preserved.
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
    v_canonical := NEW.phenotype::jsonb::text;

    -- pgcrypto lives in `extensions` schema; we are pinned to public
    -- via `SET search_path = 'public'`, so schema-qualify the call.
    v_server_hash := encode(
      extensions.digest(v_canonical::bytea, 'sha256'::text),
      'hex'
    );

    -- ⬇️ Issue #50 Bug 1.5: mismatch is degraded to WARNING.
    -- Client (JS sortKeysDeep + JSON.stringify) and server
    -- (phenotype::jsonb::text) produce different canonical strings,
    -- so hash parity is structurally impossible until the canonical
    -- serializer is unified. Tracked in ADR-292 for v0.9 follow-up.
    -- We still log mismatches so we can audit them later.
    IF v_server_hash <> NEW.content_hash THEN
      RAISE WARNING 'content_hash mismatch (non-blocking, see ADR-292): gene_id=% client=% server=%',
        NEW.id, NEW.content_hash, v_server_hash;
      -- intentional fall-through; do NOT raise exception
    END IF;

    -- ⬇️ Duplicate content_hash check is kept as EXCEPTION.
    -- This guards against spam (republishing identical phenotype under
    -- a new name) and is INDEPENDENT of the client/server hash parity
    -- problem — it only compares stored hashes against each other.
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
