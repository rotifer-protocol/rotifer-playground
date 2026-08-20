-- ============================================================
-- ADR-323 D1/D2/D3 — move the official genes to an identity someone can log in as
--
-- `rotifer-protocol` on Cloud is a GitLab-backed account, and GitLab banned it.
-- The CLI authenticates through OAuth; there is no path back. 59 published
-- genes — 32% of the registry, including the 22 rows the ADR-319 criteria
-- invalidated this morning — could not be republished, unpublished, or edited
-- by anyone. The criteria took their ranking away and the only person who
-- could fix them had ceased to exist.
--
-- This is the second time the same migration hurt. v0.8 §3.12 D-Forge-3 moved
-- the repositories off GitLab in March after a geo-ban notice; the checklist
-- covered repositories and not publishing identities, so this one stayed
-- behind for five months.
--
-- The roundtable (2026-08-19, 5:0) kept the name and moved the ownership:
--
--   3fcaab49 `rotifer-protocol`     → renamed `rotifer-protocol-legacy`, kept
--   58a7c9cf `web3coderman-dev`     → renamed `rotifer-protocol`
--   59 genes owned by 3fcaab49      → 58a7c9cf
--
-- Nothing changes for a reader: the author line still says rotifer-protocol
-- and /developers/rotifer-protocol still resolves. What changes is that the
-- name now has an account behind it that someone can sign in to.
--
-- The dead profile row is renamed, never deleted. It holds no genes and cannot
-- log in; it exists so that "an identity was here and it failed" stays on the
-- record. Deleting it would erase the incident.
--
-- Order matters and is enforced below: `username` is UNIQUE, so the dead
-- profile has to release the name before the live one can take it.
--
-- Additive per ADR-295 in the sense that matters — no schema is changed, no
-- row is removed. It is a data change, and a deliberate one: ADR-323.
-- ============================================================

DO $$
DECLARE
  v_dead    UUID := '3fcaab49-3b61-4e75-9268-5bf90394b947';
  v_live    UUID := '58a7c9cf-94ce-4ce7-bb25-e6380b2aab6c';
  v_moved   INTEGER;
  v_clashes INTEGER;
BEGIN
  -- Refuse to run against a database that is not the one this was written for.
  -- These UUIDs are production's; on a fresh or test database neither profile
  -- exists and the correct behaviour is to do nothing rather than to invent
  -- rows. Without this the migration would fail the CI replay job.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_dead)
     OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_live) THEN
    RAISE NOTICE 'ADR-323: neither identity present — not a production database, skipping';
    RETURN;
  END IF;

  -- A name collision here would silently merge two genes into one identity
  -- slot and the UNIQUE index would reject the UPDATE mid-way. Checked rather
  -- than assumed: verified 0 against production before writing this, but a
  -- verification that only happened in a shell is not a guarantee at run time.
  SELECT count(*) INTO v_clashes
  FROM genes a
  JOIN genes b
    ON b.owner_id = v_live AND b.name = a.name AND b.version = a.version
  WHERE a.owner_id = v_dead;

  IF v_clashes > 0 THEN
    RAISE EXCEPTION 'ADR-323: % (name, version) collisions between the two identities — resolve before migrating', v_clashes;
  END IF;

  -- 1. The dead identity releases the name. Renamed, not deleted: it is the
  --    record that this identity existed and failed.
  UPDATE profiles SET username = 'rotifer-protocol-legacy', updated_at = now()
   WHERE id = v_dead;

  -- 2. The live identity takes it. This also retires `web3coderman-dev`, a
  --    name the underlying GitHub account stopped using some time ago.
  UPDATE profiles SET username = 'rotifer-protocol', updated_at = now()
   WHERE id = v_live;

  -- 3. The genes follow.
  --
  -- `trg_version_immutability` rejects any UPDATE to a published row unless
  -- owner_id (among others) is unchanged, so it blocks exactly this statement.
  -- That guard is right: it protects the content of a published version, which
  -- is what ADR-317's content-addressed identity rests on. An ownership
  -- transfer is not a content change — the phenotype, the version and the hash
  -- all stay byte-identical — but the trigger has no way to tell the two apart,
  -- and widening it permanently to admit owner_id changes would open the door
  -- for every future caller rather than this one migration.
  --
  -- So it is disabled for the length of this transaction and re-enabled
  -- immediately. DDL is transactional in Postgres: if anything below fails, the
  -- rollback restores the trigger along with everything else, and there is no
  -- window in which the table is left unguarded after this transaction ends.
  --
  -- Found by simulating this migration against production-shaped fixtures on a
  -- local database. Without that it would have failed on the production push.
  -- `trg_genes_check_prev_version` blocks it for a second, subtler reason. It
  -- is a per-row BEFORE trigger asserting that `previous_version_id` points at
  -- a gene with the same owner and name. A bulk owner change updates rows one
  -- at a time, so partway through the statement an already-moved row still
  -- points at a predecessor that has not moved yet, and the check fails on
  -- ordering rather than on anything being wrong. The end state is perfectly
  -- valid; only the intermediate states are not.
  --
  -- This one the first simulation missed, because its fixtures were
  -- single-version genes with no chain at all. Production has nine versions of
  -- `contract-revision-advisor` alone. A fixture has to mirror the shape of the
  -- data, not just its column list — the production push is where that was
  -- found, and it is the reason for the chain fixture added below.
  ALTER TABLE genes DISABLE TRIGGER trg_version_immutability;
  ALTER TABLE genes DISABLE TRIGGER trg_genes_check_prev_version;

  UPDATE genes SET owner_id = v_live WHERE owner_id = v_dead;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  ALTER TABLE genes ENABLE TRIGGER trg_version_immutability;
  ALTER TABLE genes ENABLE TRIGGER trg_genes_check_prev_version;

  -- Both guards have to be back on before anything else runs. Asserted rather
  -- than trusted: a migration that silently left the table unprotected would be
  -- a far worse outcome than one that fails.
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.genes'::regclass
       AND tgname IN ('trg_version_immutability', 'trg_genes_check_prev_version')
       AND tgenabled = 'D'
  ) THEN
    RAISE EXCEPTION 'ADR-323: a guard did not come back on — aborting';
  END IF;

  -- Re-enabling a constraint trigger says nothing about whether the data still
  -- satisfies it — the trigger only looks at rows written after it comes back.
  -- Since the whole reason for switching it off was that intermediate states
  -- violated it, the honest check is the invariant itself, over every row:
  -- every version chain link must land on a gene with the same owner and name.
  IF EXISTS (
    SELECT 1
      FROM genes g
      LEFT JOIN genes prev
        ON prev.id = g.previous_version_id
       AND prev.owner_id = g.owner_id
       AND prev.name = g.name
     WHERE g.previous_version_id IS NOT NULL
       AND prev.id IS NULL
  ) THEN
    RAISE EXCEPTION 'ADR-323: version chains are broken after the move — aborting';
  END IF;

  -- 4. ADR-323 D3: the disclosure is a condition of keeping the name, so it
  --    lands in the same transaction rather than as a follow-up someone
  --    remembers. Deliberately concrete about the failure — a disclosure that
  --    omits why the last identity died is not one.
  UPDATE profiles
     SET steward_note =
           'Operated by one person, the protocol''s founder. This identity publishes the reference genes; '
           'it is not an organisation with staff. Its predecessor was a GitLab account that GitLab banned '
           'on 2026-08-19, which left 59 published genes with no one able to update them — the genes were '
           'moved here so they can be maintained again. Nothing about their authorship changed.',
         updated_at = now()
   WHERE id = v_live;

  RAISE NOTICE 'ADR-323: moved % genes to the live identity; % renamed to rotifer-protocol-legacy', v_moved, v_dead;

  -- 5. Ownership is an input to both reputation functions — gene R(g) reads
  --    the gene's own rows, and developer reputation aggregates per owner. The
  --    dead identity must fall to zero and the live one must pick the genes
  --    up; leaving that to the nightly job would show a wrong leaderboard in
  --    between.
  PERFORM recompute_all_published_reputation();
END;
$$;
