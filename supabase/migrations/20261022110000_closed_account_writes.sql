-- ============================================================
-- A closed account cannot write (T-68 follow-up; builds on 20261022100000)
--
-- close_account() closes an account, and the operator then soft-deletes the
-- auth user, which ends its sessions. An access token issued before that
-- stays valid until it expires (up to an hour). With it the account could
-- still publish a gene, take one down or put one back, create an API key,
-- submit to the Arena, register a domain, and report invocations, downloads
-- and MCP calls — and an invocation report from it would count as a distinct
-- caller on someone else's gene (§33.4 uniqueCallers).
--
-- One guard, attached BEFORE INSERT/UPDATE/DELETE to every table a client can
-- write directly or through a client-callable SECURITY DEFINER function:
--   genes                  publish; unpublish_gene() / republish_gene();
--                          the owner's update and delete policies
--   api_keys               the owner's insert/update/delete policies
--   arena_entries          the owner's submit/update policies
--   arena_evaluation_runs  the owner's insert policy
--   domain_registry        the register/update policies
--   gene_invocation_log    log_gene_invocation(_v2)
--   downloads              track_download()
--   mcp_call_log           log_mcp_call()
--   gene_visibility_log    unpublish_gene() / republish_gene()
-- (profiles has its own guard from 20261022100000.)
--
-- The test is the actor, not the row: a client request (authenticated/anon)
-- whose auth.uid() is a closed account is refused (42501) whatever it
-- writes. Other accounts are unaffected — they can still invoke, download and
-- report on a closed account's kept genes, which is what §16.5 keeps them
-- published for. A SECURITY DEFINER function keeps the client's JWT, so the
-- guard sees through the RPCs above. service_role and server sessions are
-- not clients and are not affected; close_account() itself runs as one.
--
-- The trigger is named trg_00_… so it fires first among each table's BEFORE
-- triggers (PostgreSQL fires them in name order): a closed account is turned
-- away before the Arena, content-hash or rate-limit guards do any work or
-- answer with a different error.
--
-- Additive per ADR-295: one function, nine triggers.
-- ============================================================

CREATE OR REPLACE FUNCTION guard_closed_account_write()
RETURNS TRIGGER AS $$
DECLARE
  v_uid UUID;
BEGIN
  IF coalesce(auth.role(), '') IN ('authenticated', 'anon') THEN
    v_uid := auth.uid();
    IF v_uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_uid AND p.closed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'this account is closed and can no longer write'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_closed_account_write() IS
  'T-68: a client request (authenticated/anon) from a closed account (profiles.closed_at set) cannot write. Keyed on auth.uid(), not on the row, so other accounts can still use a closed account''s kept genes. service_role and server sessions are not affected.';

REVOKE ALL ON FUNCTION guard_closed_account_write() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'genes', 'api_keys', 'arena_entries', 'arena_evaluation_runs', 'domain_registry',
    'gene_invocation_log', 'downloads', 'mcp_call_log', 'gene_visibility_log'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_00_closed_account_write ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_00_closed_account_write BEFORE INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION guard_closed_account_write()', t);
  END LOOP;
END;
$$;
