-- ============================================================
-- Closing an account without deleting its genes (T-68; deviation B in
-- .agent-team/drafts/T-66-spec-alignment.md)
--
-- Deleting a user (auth.users → profiles → genes, all ON DELETE CASCADE)
-- takes every gene the account published with it, and with each gene its
-- Arena row, evaluation runs, invocation and download history and audit
-- trail. Spec §16.4 (MUST) says an agent's genes do not disappear when it is
-- terminated, and §16.5 (MUST) says the genes only it used go to ARCHIVED
-- while genes other agents use keep their state ("genes are a public resource
-- of the Arena"). There is no self-service closure today; the only path is an
-- operator deleting the user, which breaks both.
--
-- This migration adds that closure as one server-side function and blocks
-- the delete that bypasses it:
--
--   close_account(p_user_id, p_reason)  SECURITY DEFINER, EXECUTE for
--     service_role only. In one transaction:
--     1. snapshots the account's developer_reputation row (§16.4
--        reputationSnapshot — before archiving lowers it);
--     2. for every gene the account has published now:
--          shared    = another account invoked it (gene_invocation_log row
--                      whose caller is not the owner) or anyone but the owner
--                      downloaded it (downloads row whose user is not the
--                      owner, anonymous downloads included)
--          exclusive = not shared
--        exclusive genes are taken down the way unpublish_gene() does it (the
--        visibility marker, published = false, a gene_visibility_log
--        'unpublish' row with the account as actor); shared genes are left
--        published; genes taken down before closure are left as they are;
--     3. recomputes developer_reputation;
--     4. removes or anonymizes what identifies the person (§30): username →
--        'closed_' + the account id without dashes, avatar_url, provider_id,
--        steward_note, steward_note_i18n cleared, the account's API keys
--        deleted, its own download rows detached (user_id → NULL; the count
--        stays);
--     5. sets profiles.closed_at and writes an account_legacy_records row
--        (§16.4 LegacyRecord).
--     Every gene row, Arena row, evaluation run, invocation row, visibility
--     log row and reputation row is kept.
--
--   guard_profile_delete  BEFORE DELETE on profiles, every role: refuses
--     (42501) to delete a profile that owns any gene. That covers a direct
--     delete and the cascade from auth.users — an operator hard-deleting the
--     user in the dashboard or through the Admin API gets an error and
--     nothing is deleted. A profile that owns no gene can still be deleted
--     as before (the e2e suites delete their fixture genes, then their users).
--
--   guard_profile_client_write  BEFORE INSERT OR UPDATE on profiles, client
--     roles only (authenticated / anon): a client cannot set closed_at, and
--     cannot change a closed profile at all (its access token outlives the
--     closure by up to its expiry).
--
-- How spec states map to this schema (genes has no lifecycle column):
--   DRAFT                 published = false, no gene_visibility_log row
--   PUBLISHED / ACTIVE    published = true
--   ARCHIVED              published = false after an 'unpublish' row in
--                         gene_visibility_log. The leaderboard and Arena
--                         history views filter on g.published = true, so the
--                         gene leaves the Arena; its row, artifact and records
--                         stay, and clients that installed it keep their copy
--                         (§46.1 "removed from the Arena, existing users keep
--                         access")
--   DEPRECATED, TOMBSTONED  not represented
-- An account maps to §16 as: open = Agent ACTIVE, closed_at set = TERMINATED.
--
-- The auth side is not done here. After close_account() succeeds, the
-- operator soft-deletes the auth user through the GoTrue Admin API
-- (DELETE /auth/v1/admin/users/{id} with {"should_soft_delete": true}), which
-- keeps the auth.users row, obfuscates its email and phone and ends its
-- sessions. A hard delete stays refused for as long as the profile owns genes.
--
-- Additive per ADR-295: one column, one table, three functions, two triggers.
-- No existing column, policy or foreign key is changed.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The closed flag
-- ------------------------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.closed_at IS
  'T-68: set by close_account() when the account is closed (spec §16 TERMINATED). NULL for an open account. Clients cannot set it.';

-- ------------------------------------------------------------
-- 2. The legacy record (§16.4)
-- ------------------------------------------------------------
-- account_id has no foreign key on purpose: the record is history and must
-- outlive whatever happens to the profile later.
-- gene_contributions: [{gene_id, role, fitness_at_termination, state_before,
-- state_after}], one entry per gene the account ever published — published
-- at closure, or taken down earlier (it has a gene_visibility_log row).
-- Drafts that were never published are left out — they were never public
-- and the record is.
-- termination_reason is a code, not free text, because the record is public.
-- active_genome is not recorded: an agent's genome lives on the client, the
-- registry never sees it.
CREATE TABLE IF NOT EXISTS account_legacy_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE,
  gene_contributions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reputation_snapshot JSONB,
  terminated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  termination_reason TEXT NOT NULL
    CHECK (termination_reason IN ('user_request', 'operator'))
);

ALTER TABLE account_legacy_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Legacy records are readable" ON account_legacy_records;
CREATE POLICY "Legacy records are readable"
  ON account_legacy_records FOR SELECT USING (true);

-- No write policies: rows come from close_account() only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON account_legacy_records FROM PUBLIC, anon, authenticated;
GRANT SELECT ON account_legacy_records TO anon, authenticated;

COMMENT ON TABLE account_legacy_records IS
  'T-68: spec §16.4 LegacyRecord, one row per closed account. Written by close_account() only.';

-- ------------------------------------------------------------
-- 3. close_account()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION close_account(p_user_id UUID, p_reason TEXT DEFAULT 'user_request')
RETURNS TABLE (archived_genes INTEGER, kept_genes INTEGER, legacy_record_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile  profiles%ROWTYPE;
  v_gene     RECORD;
  v_shared   BOOLEAN;
  v_snapshot JSONB;
  v_contrib  JSONB := '[]'::jsonb;
  v_archived INTEGER := 0;
  v_kept     INTEGER := 0;
  v_record   UUID;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('user_request', 'operator') THEN
    RAISE EXCEPTION 'close_account: reason must be user_request or operator, got %', p_reason
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'close_account: no account %', p_user_id
      USING ERRCODE = 'P0002';
  END IF;
  -- Not idempotent by choice, like unpublish_gene(): a second call that
  -- reported success would hide that the first one already ran.
  IF v_profile.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'close_account: account % was closed at %', p_user_id, v_profile.closed_at
      USING ERRCODE = '22023';
  END IF;

  -- Before archiving: §16.4 asks for the reputation at termination.
  SELECT jsonb_build_object(
           'score', r.score,
           'genes_published', r.genes_published,
           'total_downloads', r.total_downloads,
           'arena_wins', r.arena_wins,
           'community_bonus', r.community_bonus,
           'computed_at', r.computed_at)
    INTO v_snapshot
    FROM developer_reputation r WHERE r.user_id = p_user_id;

  -- Every gene the account ever published: published now, or taken down
  -- earlier through unpublish_gene() (which is the only way a published row
  -- becomes unpublished, and which writes gene_visibility_log). A gene taken
  -- down before closure is still a contribution (§16.4 "genes contributed by
  -- this Agent") and is recorded as ARCHIVED both before and after.
  FOR v_gene IN
    SELECT g.id, g.published, a.fitness_value
      FROM genes g
      LEFT JOIN arena_entries a ON a.gene_id = g.id
     WHERE g.owner_id = p_user_id
       AND (g.published
            OR EXISTS (SELECT 1 FROM gene_visibility_log v WHERE v.gene_id = g.id))
     ORDER BY g.created_at, g.id
       FOR UPDATE OF g
  LOOP
    IF NOT v_gene.published THEN
      v_contrib := v_contrib || jsonb_build_array(jsonb_build_object(
        'gene_id', v_gene.id,
        'role', 'AUTHOR',
        'fitness_at_termination', v_gene.fitness_value,
        'state_before', 'ARCHIVED',
        'state_after', 'ARCHIVED'));
      CONTINUE;
    END IF;

    v_shared :=
      EXISTS (SELECT 1 FROM gene_invocation_log l
               WHERE l.gene_id = v_gene.id
                 AND l.caller_agent_id IS DISTINCT FROM p_user_id::text)
      OR EXISTS (SELECT 1 FROM downloads d
                  WHERE d.gene_id = v_gene.id
                    AND d.user_id IS DISTINCT FROM p_user_id);

    IF v_shared THEN
      v_kept := v_kept + 1;
    ELSE
      PERFORM set_config('rotifer.visibility_change', 'on', true);
      UPDATE genes g SET published = false WHERE g.id = v_gene.id;
      PERFORM set_config('rotifer.visibility_change', '', true);

      INSERT INTO gene_visibility_log (gene_id, actor_id, action, reason)
      VALUES (v_gene.id, p_user_id, 'unpublish', 'account closed');
      v_archived := v_archived + 1;
    END IF;

    v_contrib := v_contrib || jsonb_build_array(jsonb_build_object(
      'gene_id', v_gene.id,
      'role', 'AUTHOR',
      'fitness_at_termination', v_gene.fitness_value,
      'state_before', 'PUBLISHED',
      'state_after', CASE WHEN v_shared THEN 'PUBLISHED' ELSE 'ARCHIVED' END));
  END LOOP;

  PERFORM compute_developer_reputation(p_user_id);

  -- §30: what identifies the person goes; what other accounts' records rely
  -- on stays. The account id itself stays — every kept record points at it —
  -- but nothing public maps it to a person any more.
  DELETE FROM api_keys k WHERE k.owner_id = p_user_id;
  UPDATE downloads d SET user_id = NULL WHERE d.user_id = p_user_id;

  UPDATE profiles p
     SET username = 'closed_' || replace(p_user_id::text, '-', ''),
         avatar_url = NULL,
         provider_id = '',
         steward_note = NULL,
         steward_note_i18n = NULL,
         closed_at = now(),
         updated_at = now()
   WHERE p.id = p_user_id;

  INSERT INTO account_legacy_records
    (account_id, gene_contributions, reputation_snapshot, termination_reason)
  VALUES (p_user_id, v_contrib, v_snapshot, p_reason)
  RETURNING id INTO v_record;

  RETURN QUERY SELECT v_archived, v_kept, v_record;
END;
$$;

COMMENT ON FUNCTION close_account(UUID, TEXT) IS
  'T-68: close an account per spec §16.4/§16.5/§30. Exclusive published genes are unpublished (ARCHIVED) with a visibility-log row, genes another account invoked or downloaded stay published, all records are kept, the profile is anonymized and a legacy record is written. service_role only. Follow with a GoTrue soft delete of the auth user.';

REVOKE ALL ON FUNCTION close_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION close_account(UUID, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 4. Deleting a profile that owns genes is refused, for every role
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_profile_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM genes g WHERE g.owner_id = OLD.id) THEN
    RAISE EXCEPTION
      'profiles: account % owns genes, and deleting it would delete them with their Arena and invocation records — close it with close_account() instead (spec §16.4, §16.5)',
      OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_profile_delete() IS
  'T-68: a profile that owns any gene cannot be deleted, by any role and including the cascade from auth.users. Use close_account().';

DROP TRIGGER IF EXISTS trg_guard_profile_delete ON profiles;
CREATE TRIGGER trg_guard_profile_delete
  BEFORE DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION guard_profile_delete();

REVOKE ALL ON FUNCTION guard_profile_delete() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Clients cannot close, or touch a closed, profile
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_profile_client_write()
RETURNS TRIGGER AS $$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'profiles: this account is closed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'profiles: an account is closed with close_account(), not by setting closed_at'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_profile_client_write() IS
  'T-68: a client (authenticated/anon) cannot set profiles.closed_at and cannot change a closed profile. service_role and server sessions are not affected.';

DROP TRIGGER IF EXISTS trg_guard_profile_client_write ON profiles;
CREATE TRIGGER trg_guard_profile_client_write
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION guard_profile_client_write();

REVOKE ALL ON FUNCTION guard_profile_client_write() FROM PUBLIC, anon, authenticated;
