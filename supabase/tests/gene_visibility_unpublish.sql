-- ============================================================
-- pgTAP tests for taking a published version down
-- File: supabase/tests/gene_visibility_unpublish.sql
-- ============================================================
--
-- Migration 20260821000000. `rotifer unpublish` shipped in #217 and never once
-- worked: it PATCHed `published = false` at the table, and
-- `trg_version_immutability` rejects that outright. The command had tests —
-- `tests/unit/cloud-unpublish.test.ts` — but they mocked `fetch`, so they
-- asserted how the client reacts to a reply the database would never send. The
-- layer that broke was the only layer nothing exercised.
--
-- Hence this file. Every assertion here runs against a real database with the
-- real triggers attached.
--
-- Half of these tests exist to prove the fix did NOT widen the guard. A change
-- that makes unpublish work is easy; a change that makes unpublish work while
-- leaving published content immutable is the actual requirement, and only the
-- negative cases can tell those apart.
--
-- Run inside the supabase test container:
--   supabase test db

BEGIN;

SELECT plan(14);

-- Two authors, so "not yours" can be tested rather than assumed.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('a1111111-1111-4111-8111-111111111111', 'author@example.com',   '{"user_name": "author"}'::jsonb),
  ('a2222222-2222-4222-8222-222222222222', 'stranger@example.com', '{"user_name": "stranger"}'::jsonb);

-- Production shape: a published gene needs a content_hash (chk_published_content_hash),
-- a fidelity from the enum (chk_gene_fidelity), and a hash no other row holds
-- (trg_validate_content_hash rejects duplicates). A fixture that skips any of
-- these does not reach the trigger under test.
INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash) VALUES
  ('9e1e0000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111',
   'takedown_probe', '1.0.0', 'testing', '{"logic":"one"}'::jsonb, 'probe', 'Native', true,
   'sha256:' || repeat('a', 64)),
  ('9e1e0000-0000-4000-8000-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'already_down', '1.0.0', 'testing', '{"logic":"two"}'::jsonb, 'probe', 'Native', false,
   'sha256:' || repeat('b', 64));

-- ------------------------------------------------------------
-- The defect this migration fixes
-- ------------------------------------------------------------

-- T1: the shape of the bug, pinned. If someone ever "simplifies" the client
-- back to a direct PATCH, this is the test that says why they cannot.
SELECT throws_ok(
  $$ UPDATE genes SET published = false WHERE id = '9e1e0000-0000-4000-8000-000000000001' $$,
  'Published gene version is immutable. Bump version number to publish updates.',
  'T1: a direct PATCH of published is still refused — the way #217 was refused'
);

-- ------------------------------------------------------------
-- The sanctioned path
-- ------------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

-- T2: the author can take their own version down
SELECT lives_ok(
  $$ SELECT unpublish_gene('9e1e0000-0000-4000-8000-000000000001', 'superseded') $$,
  'T2: the author can take their own published version down'
);

-- T3: and it actually moved, rather than merely not throwing
SELECT is(
  (SELECT published FROM genes WHERE id = '9e1e0000-0000-4000-8000-000000000001'),
  false,
  'T3: the row is unpublished afterwards'
);

-- T4: the act is on the record, with who and why
SELECT is(
  (SELECT actor_id::text || '/' || action || '/' || reason
     FROM gene_visibility_log WHERE gene_id = '9e1e0000-0000-4000-8000-000000000001'),
  'a1111111-1111-4111-8111-111111111111/unpublish/superseded',
  'T4: the takedown is recorded with its actor and reason'
);

-- T5: the row survives. Arena entries, invocation history and anyone else''s
-- dependency keep their referent; only visibility changed.
SELECT is(
  (SELECT count(*)::int FROM genes WHERE id = '9e1e0000-0000-4000-8000-000000000001'),
  1,
  'T5: unpublishing keeps the row — it is a visibility change, not a delete'
);

-- T6: a no-op is reported as one. Answering "done" to a command that did
-- nothing is how #217 read as working to everyone who never checked.
SELECT throws_ok(
  $$ SELECT unpublish_gene('9e1e0000-0000-4000-8000-000000000001') $$,
  '22023',
  NULL,
  'T6: unpublishing an already-unpublished version is refused, not silently accepted'
);

-- T7: the round trip
SELECT lives_ok(
  $$ SELECT republish_gene('9e1e0000-0000-4000-8000-000000000001', 'back') $$,
  'T7: the author can put the version back'
);

SELECT is(
  (SELECT published FROM genes WHERE id = '9e1e0000-0000-4000-8000-000000000001'),
  true,
  'T8: republishing restores it'
);

-- T9: both halves of the story reach the log, not just the disappearance
SELECT is(
  (SELECT string_agg(action, ',' ORDER BY created_at)
     FROM gene_visibility_log WHERE gene_id = '9e1e0000-0000-4000-8000-000000000001'),
  'unpublish,republish',
  'T9: the log carries the takedown and the restore'
);

-- ------------------------------------------------------------
-- Authorisation
-- ------------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"a2222222-2222-4222-8222-222222222222","role":"authenticated"}', true);

-- T10: SECURITY DEFINER bypasses RLS, so the ownership check inside the
-- function is the only thing standing here. Assert it stands.
SELECT throws_ok(
  $$ SELECT unpublish_gene('9e1e0000-0000-4000-8000-000000000001') $$,
  '42501',
  NULL,
  'T10: a stranger cannot take down someone else''s version'
);

-- T11: and nothing was logged by the attempt
SELECT is(
  (SELECT count(*)::int FROM gene_visibility_log
    WHERE gene_id = '9e1e0000-0000-4000-8000-000000000001'
      AND actor_id = 'a2222222-2222-4222-8222-222222222222'),
  0,
  'T11: a refused takedown leaves no log row'
);

-- ------------------------------------------------------------
-- The guard was not widened
-- ------------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

-- T12: content is still immutable on a published version. This is the test that
-- distinguishes "unpublish works" from "the immutability guard was removed".
SELECT throws_ok(
  $$ UPDATE genes SET description = 'tampered' WHERE id = '9e1e0000-0000-4000-8000-000000000001' $$,
  'Published gene version is immutable. Bump version number to publish updates.',
  'T12: published content is still immutable'
);

-- T13: the marker cannot carry a content change with it. Without this, the
-- exception would be a hole wide enough to rewrite a published phenotype.
SELECT set_config('rotifer.visibility_change', 'on', true);
SELECT throws_ok(
  $$ UPDATE genes SET published = false, description = 'smuggled'
      WHERE id = '9e1e0000-0000-4000-8000-000000000001' $$,
  'Published gene version is immutable. Bump version number to publish updates.',
  'T13: a marked transaction still cannot change content alongside visibility'
);
SELECT set_config('rotifer.visibility_change', '', true);

-- T14: the log is not writable by hand. An audit trail its subject can edit is
-- decoration.
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE tablename = 'gene_visibility_log' AND cmd <> 'SELECT'),
  0,
  'T14: nothing but the SECURITY DEFINER functions can write the log'
);

SELECT * FROM finish();
ROLLBACK;
