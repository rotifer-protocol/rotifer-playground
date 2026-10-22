-- ============================================================
-- A client cannot delete a gene that carries evidence (T-64; audit
-- .agent-team/drafts/T-58-arena-rls-audit.md F3)
--
-- genes has the policy "Owners can delete own genes", and nine tables
-- reference genes(id) ON DELETE CASCADE. So an author could delete a gene
-- version and take its Arena row, its invalidation, its evaluation runs, its
-- invocation and download history and its publish/unpublish audit trail
-- with it, then re-create the gene and submit again. ADR-319's "no delete
-- policy — nobody can delete it" held for arena_entries itself but not for
-- the gene it hangs off.
--
-- A BEFORE DELETE guard on genes refuses a client delete (PostgREST roles
-- authenticated / anon) of a gene that is published now, or has a row in any
-- of those nine tables (42501). The test is the gene's history, not its
-- current state: a version that was published and then taken down with
-- unpublish_gene() is unpublished now, but its gene_visibility_log row (and
-- whatever was recorded while it was public) says it was published, and the
-- delete is refused (T-64 acceptance).
--
-- The nine tables, every one of which counts:
--   arena_entries             the Arena record and its invalidation
--   arena_evaluation_runs     the measurements behind a score
--   gene_artifact_scan        what an invalidation criterion read
--   gene_invocation_log       other accounts' calls (§33.4 input)
--   gene_contribution_metrics aggregates of that log
--   gene_reputation           the reputation history computed from the above
--   season_archives           the gene's standing at each season's end
--   downloads                 who installed it
--   gene_visibility_log       the publish/unpublish audit trail
-- (genes.previous_version_id references genes(id) without a cascade, so a
-- version another one builds on cannot be deleted anyway.)
--
-- What stays deletable: a gene that is not published and has no row in any
-- of the nine — a draft that was never published, never evaluated, never
-- invoked or downloaded. "Never published" is what the two checks together
-- establish: a version that is published now is refused outright, and one
-- that was published and is not any more was taken down by unpublish_gene()
-- — the only way a client can, since trg_version_immutability blocks a
-- direct UPDATE of published — which writes gene_visibility_log. Reputation and contribution metrics are computed for published
-- genes only, so a draft has none. Taking a version down is unpublish_gene()
-- (an audited UPDATE) and is unaffected. service_role and server-side
-- sessions are not clients and are not affected.
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
DECLARE
  v_found TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN OLD;
  END IF;

  IF OLD.published THEN
    RAISE EXCEPTION
      'genes: a published gene cannot be deleted; take it down with unpublish_gene()'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM arena_entries t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'arena_entries'); END IF;
  IF EXISTS (SELECT 1 FROM arena_evaluation_runs t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'arena_evaluation_runs'); END IF;
  IF EXISTS (SELECT 1 FROM gene_artifact_scan t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'gene_artifact_scan'); END IF;
  IF EXISTS (SELECT 1 FROM gene_invocation_log t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'gene_invocation_log'); END IF;
  IF EXISTS (SELECT 1 FROM gene_contribution_metrics t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'gene_contribution_metrics'); END IF;
  IF EXISTS (SELECT 1 FROM gene_reputation t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'gene_reputation'); END IF;
  IF EXISTS (SELECT 1 FROM season_archives t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'season_archives'); END IF;
  IF EXISTS (SELECT 1 FROM downloads t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'downloads'); END IF;
  IF EXISTS (SELECT 1 FROM gene_visibility_log t WHERE t.gene_id = OLD.id) THEN
    v_found := array_append(v_found, 'gene_visibility_log'); END IF;

  IF cardinality(v_found) > 0 THEN
    RAISE EXCEPTION
      'genes: this gene has a record in % — deleting it would delete that record with it',
      array_to_string(v_found, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_gene_client_delete() IS
  'T-64: a client (authenticated/anon) cannot delete a gene that is published now or has a row in any of the nine tables that cascade from genes (Arena record, evaluation runs, artifact scan, invocation log, contribution metrics, reputation, season archives, downloads, visibility log). A draft that was never published or used stays deletable; service_role and server sessions are not affected.';

DROP TRIGGER IF EXISTS trg_guard_gene_client_delete ON genes;
CREATE TRIGGER trg_guard_gene_client_delete
  BEFORE DELETE ON genes
  FOR EACH ROW EXECUTE FUNCTION guard_gene_client_delete();

REVOKE ALL ON FUNCTION guard_gene_client_delete() FROM PUBLIC, anon, authenticated;
