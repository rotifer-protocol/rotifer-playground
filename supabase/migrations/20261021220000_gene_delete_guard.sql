-- ============================================================
-- A client cannot delete a gene that carries evidence (T-64; audit
-- .agent-team/drafts/T-58-arena-rls-audit.md F3)
--
-- genes has the policy "Owners can delete own genes", and arena_entries,
-- arena_evaluation_runs (and the invalidation recorded on the Arena row)
-- reference genes(id) ON DELETE CASCADE. So an author could delete a gene
-- version and take its Arena row, its invalidation and every evaluation run
-- with it, then re-create the gene and submit again. ADR-319's "no delete
-- policy — nobody can delete it" held for arena_entries itself but not for
-- the gene it hangs off.
--
-- A BEFORE DELETE guard on genes refuses a client delete (PostgREST roles
-- authenticated / anon) of a gene that is published, or has an Arena row,
-- or has evaluation runs (42501). Taking a published version down goes
-- through unpublish_gene() (an audited UPDATE, not a delete) and is
-- unaffected. A draft that was never published and never evaluated can
-- still be deleted by its owner. service_role and server-side sessions are
-- not clients and are not affected.
--
-- No client flow deletes genes today: the CLI and the MCP server take
-- versions down with unpublish_gene() and roll back locally (snapshots); no
-- other repo deletes genes with a user's token. The e2e tests delete their
-- fixtures with the service_role key.
--
-- Additive per ADR-295: one function and one trigger. The foreign keys and
-- the delete policy are unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION guard_gene_client_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN OLD;
  END IF;

  IF OLD.published THEN
    RAISE EXCEPTION
      'genes: a published gene cannot be deleted; take it down with unpublish_gene()'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM arena_entries a WHERE a.gene_id = OLD.id)
     OR EXISTS (SELECT 1 FROM arena_evaluation_runs r WHERE r.gene_id = OLD.id) THEN
    RAISE EXCEPTION
      'genes: a gene with an Arena record or evaluation runs cannot be deleted; its evidence would be deleted with it'
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_gene_client_delete() IS
  'T-64: a client (authenticated/anon) cannot delete a gene that is published or has Arena rows or evaluation runs — the cascade would delete that evidence. Drafts that were never published or evaluated stay deletable; service_role and server sessions are not affected.';

DROP TRIGGER IF EXISTS trg_guard_gene_client_delete ON genes;
CREATE TRIGGER trg_guard_gene_client_delete
  BEFORE DELETE ON genes
  FOR EACH ROW EXECUTE FUNCTION guard_gene_client_delete();

REVOKE ALL ON FUNCTION guard_gene_client_delete() FROM PUBLIC, anon, authenticated;
