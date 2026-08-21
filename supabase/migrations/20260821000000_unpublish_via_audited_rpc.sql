-- ============================================================
-- Taking a published version down: an audited RPC, not a flag flip
--
-- `rotifer unpublish` (#217) PATCHed `published = false` straight at the table.
-- `trg_version_immutability` fires BEFORE UPDATE WHEN (OLD.published = true)
-- and permits an update only if a whitelist of columns is unchanged — and
-- `NEW.published IS NOT DISTINCT FROM OLD.published` is in that whitelist. So
-- every unpublish since #217 raised:
--
--     Published gene version is immutable. Bump version number to publish updates.
--
-- Reproduced against a published fixture row on a local database before writing
-- any of this. Both trigger migrations (20260330120000, 20260330140000) are
-- applied in production, so production behaved identically: the command has
-- never worked. Note the asymmetry it shipped with — `republish` updates a row
-- where OLD.published = false, the trigger's WHEN clause never fires, and that
-- half worked fine. The pair reads as "take it down / put it back" and only the
-- second half functioned.
--
-- WHY AN RPC RATHER THAN NARROWING THE TRIGGER
--
-- Visibility is not content. `content_hash` is computed over the phenotype;
-- `published` never enters it, so blocking the flag was never protecting the
-- content-addressed identity of ADR-317. The obvious fix is to drop `published`
-- from the whitelist and let the PATCH through. Rejected, for two reasons:
--
--   1. It widens the guard's hole for every writer, not just the sanctioned
--      path. An Arena score, a V(g) badge and a reputation contribution all
--      hang off a published version, so "make it disappear" is a way to remove
--      evidence. That deserves an authorisation check written down in one
--      place, not RLS alone.
--   2. It leaves the act silent. A version that vanishes from the registry
--      should say who took it down and when.
--
-- So the blanket guard stays intact and the exception is narrow: the trigger
-- lets a published→unpublished transition through only when the transaction
-- carries a marker that `unpublish_gene()` sets, and only when nothing but the
-- flag has moved.
--
-- The marker is deliberately NOT the security boundary, and it should not be
-- mistaken for one. Probed on a local database: with the marker set by hand, a
-- published-only update succeeds as superuser and is refused (`UPDATE 0`) for
-- an `authenticated` role that does not own the row — RLS still decides who may
-- touch what. `set_config` lives in `pg_catalog` and is not exposed through
-- PostgREST, which sets only `request.*` GUCs from headers, and the sole
-- function in `public` that mentions it is `unpublish_gene` itself with a
-- constant argument. The residual exposure is therefore bounded to an author
-- flipping their own gene without leaving a log row, and there is no route to
-- do it. The RPC's ownership check is what authorises; the marker only keeps
-- the guard from being widened for every writer.
--
-- Considered and rejected: having the RPC `ALTER TABLE ... DISABLE TRIGGER`
-- around the update, the way 20260819260000 does. That takes ACCESS EXCLUSIVE
-- on `genes` and serialises every write to the table. Acceptable for a one-shot
-- migration, not for a command a user runs.
--
-- ADR-295: additive only. New table, new functions, and a CREATE OR REPLACE of
-- the trigger function that preserves its existing branch verbatim — the same
-- shape 20260330140000 used to extend it.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The record
-- ------------------------------------------------------------
-- Named for the existing `*_log` tables (gene_invocation_log, mcp_call_log,
-- reputation_compute_log) and locked down the same way: readable, never
-- directly writable. Rows arrive only through the SECURITY DEFINER functions
-- below, so an entry cannot be forged or quietly removed by its subject.
CREATE TABLE IF NOT EXISTS gene_visibility_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gene_id uuid NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('unpublish', 'republish')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gene_visibility_log_gene
  ON gene_visibility_log (gene_id, created_at DESC);

ALTER TABLE gene_visibility_log ENABLE ROW LEVEL SECURITY;

-- The point of an audit trail is that it can be read. A registry that serves a
-- version and later stops should be able to say so out loud.
DROP POLICY IF EXISTS "Visibility log is readable" ON gene_visibility_log;
CREATE POLICY "Visibility log is readable"
  ON gene_visibility_log FOR SELECT USING (true);

-- No INSERT/UPDATE/DELETE policies, deliberately: writes come from the
-- SECURITY DEFINER functions below and nowhere else.

-- ------------------------------------------------------------
-- 2. The narrow exception in the immutability guard
-- ------------------------------------------------------------
-- The first branch is 20260330140000's, unchanged. The second is new: only the
-- visibility flag may move, only inside a transaction the RPC has marked, and
-- content_hash is pinned alongside the rest so a visibility change cannot
-- smuggle a hash with it.
CREATE OR REPLACE FUNCTION enforce_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.published = true THEN
    -- Security metadata only (content_hash, wasm_hash) — 20260330140000.
    IF (
      NEW.name IS NOT DISTINCT FROM OLD.name AND
      NEW.domain IS NOT DISTINCT FROM OLD.domain AND
      NEW.version IS NOT DISTINCT FROM OLD.version AND
      NEW.phenotype IS NOT DISTINCT FROM OLD.phenotype AND
      NEW.description IS NOT DISTINCT FROM OLD.description AND
      NEW.readme IS NOT DISTINCT FROM OLD.readme AND
      NEW.fidelity IS NOT DISTINCT FROM OLD.fidelity AND
      NEW.published IS NOT DISTINCT FROM OLD.published AND
      NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
    ) THEN
      RETURN NEW;
    END IF;

    -- A sanctioned visibility change: unpublish_gene() marked this transaction,
    -- and the flag is the only thing that moved.
    IF (
      coalesce(current_setting('rotifer.visibility_change', true), '') = 'on' AND
      NEW.published IS DISTINCT FROM OLD.published AND
      NEW.name IS NOT DISTINCT FROM OLD.name AND
      NEW.domain IS NOT DISTINCT FROM OLD.domain AND
      NEW.version IS NOT DISTINCT FROM OLD.version AND
      NEW.phenotype IS NOT DISTINCT FROM OLD.phenotype AND
      NEW.description IS NOT DISTINCT FROM OLD.description AND
      NEW.readme IS NOT DISTINCT FROM OLD.readme AND
      NEW.fidelity IS NOT DISTINCT FROM OLD.fidelity AND
      NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id AND
      NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Published gene version is immutable. Bump version number to publish updates.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

-- ------------------------------------------------------------
-- 3. Taking a version down
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION unpublish_gene(p_gene_id uuid, p_reason text DEFAULT NULL)
RETURNS TABLE (id uuid, name text, version text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   genes%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sign in before taking a version down.'
      USING ERRCODE = '28000';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so ownership is checked here explicitly.
  -- FOR UPDATE so a concurrent unpublish cannot write two log rows for one flip.
  SELECT * INTO v_row FROM genes g WHERE g.id = p_gene_id FOR UPDATE;

  -- One answer for "does not exist" and "not yours", on purpose: an unpublished
  -- version is invisible under RLS, and answering differently would confirm a
  -- stranger's private version exists.
  IF NOT FOUND OR v_row.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Gene % is either not yours or does not exist — only the author of a version can take it down.', p_gene_id
      USING ERRCODE = '42501';
  END IF;

  -- Not idempotent by choice. Reporting success for a no-op is how a broken
  -- command looks like a working one.
  IF v_row.published = false THEN
    RAISE EXCEPTION 'Gene % is already unpublished.', p_gene_id
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('rotifer.visibility_change', 'on', true);
  UPDATE genes g SET published = false WHERE g.id = p_gene_id;
  PERFORM set_config('rotifer.visibility_change', '', true);

  INSERT INTO gene_visibility_log (gene_id, actor_id, action, reason)
  VALUES (p_gene_id, v_actor, 'unpublish', p_reason);

  -- The author's score must not keep counting a version the registry no longer
  -- serves. `compute_developer_reputation` sums over `published = true`, but
  -- nothing recomputed it here: `trg_gene_published_reputation` fires only
  -- WHEN (new.published = true), and `fn_gene_rep_cascade_developer` is an
  -- AFTER INSERT trigger on gene_reputation, so an update to an existing row
  -- does not cascade either. Unreachable until now — no unpublish ever
  -- succeeded — so this closes a gap that this migration itself opens.
  PERFORM compute_developer_reputation(v_row.owner_id);

  RETURN QUERY SELECT v_row.id, v_row.name, v_row.version;
END;
$$;

-- ------------------------------------------------------------
-- 4. Putting it back
-- ------------------------------------------------------------
-- Republishing already worked through a direct PATCH — the trigger's WHEN
-- clause does not fire on a row where OLD.published = false — so this is not a
-- bug fix. It exists so the record has both halves: a log that only ever shows
-- disappearances tells half the story. No marker is set, for the same reason:
-- the guard is not in the way on this path, and setting a flag that nothing
-- reads would imply otherwise.
CREATE OR REPLACE FUNCTION republish_gene(p_gene_id uuid, p_reason text DEFAULT NULL)
RETURNS TABLE (id uuid, name text, version text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   genes%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Sign in before putting a version back.'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM genes g WHERE g.id = p_gene_id FOR UPDATE;

  IF NOT FOUND OR v_row.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Gene % is either not yours or does not exist — only the author of a version can put it back.', p_gene_id
      USING ERRCODE = '42501';
  END IF;

  IF v_row.published = true THEN
    RAISE EXCEPTION 'Gene % is already published.', p_gene_id
      USING ERRCODE = '22023';
  END IF;

  UPDATE genes g SET published = true WHERE g.id = p_gene_id;

  INSERT INTO gene_visibility_log (gene_id, actor_id, action, reason)
  VALUES (p_gene_id, v_actor, 'republish', p_reason);

  -- trg_gene_published_reputation fires on this path and recomputes the gene,
  -- but the developer aggregate still needs saying out loud — see above.
  PERFORM compute_developer_reputation(v_row.owner_id);

  RETURN QUERY SELECT v_row.id, v_row.name, v_row.version;
END;
$$;

REVOKE ALL ON FUNCTION unpublish_gene(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION republish_gene(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unpublish_gene(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION republish_gene(uuid, text) TO authenticated;

COMMENT ON FUNCTION unpublish_gene(uuid, text) IS
  'Take a published version off the registry. Checks ownership, records the act in gene_visibility_log, and recomputes the author''s reputation. The direct PATCH this replaces was rejected by trg_version_immutability and never worked.';
COMMENT ON FUNCTION republish_gene(uuid, text) IS
  'Put an unpublished version back. Its counterpart worked already; this exists so both halves reach gene_visibility_log.';
COMMENT ON TABLE gene_visibility_log IS
  'Who took a version down or put it back, and when. Written only by unpublish_gene / republish_gene.';
