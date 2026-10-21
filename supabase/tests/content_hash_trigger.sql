-- ============================================================
-- pgTAP tests for the content_hash publish trigger
-- File: supabase/tests/content_hash_trigger.sql
-- ============================================================
--
-- ADR-341 (path c′). validate_content_hash_on_publish() used to recompute the
-- hash server-side as sha256(phenotype::jsonb::text). That can never equal the
-- client's hash — the client sorts keys and serializes with JSON.stringify — so
-- since migration 20260528021934 the recompute only emitted a WARNING that
-- nothing read. Migration 20261020120000 removes the recompute and keeps the
-- rest of the 20260601083520 function body as it was.
--
-- What the tests separate:
--   H2-a  the recompute is gone            (fails on the 06-01 body)
--   H2-b  the early-return guard is kept   (fails on the 05-28 body, so a
--         rollback to the wrong base is caught)
--   H2-c/d/e/f  duplicate check, its scope, the NULL guard and the
--         unpublish / republish path are unchanged (regression protection)
--
-- Run inside the supabase test container:
--   supabase test db

BEGIN;

SELECT plan(12);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('c1111111-1111-4111-8111-111111111111', 'hash-author@example.com', '{"user_name": "hash_author"}'::jsonb),
  ('c2222222-2222-4222-8222-222222222222', 'hash-other@example.com',  '{"user_name": "hash_other"}'::jsonb);

-- ------------------------------------------------------------
-- H2-a: no server-side recompute
-- ------------------------------------------------------------

SELECT ok(
  position('jsonb::text' in pg_get_functiondef('public.validate_content_hash_on_publish()'::regprocedure)) = 0,
  'H2-a: the trigger no longer canonicalizes phenotype with jsonb::text'
);

SELECT ok(
  position('digest(' in pg_get_functiondef('public.validate_content_hash_on_publish()'::regprocedure)) = 0,
  'H2-a: the trigger no longer hashes anything itself'
);

-- A content_hash unrelated to the phenotype publishes: the client's hash is
-- the only one, as it already was in effect.
SELECT lives_ok(
  $$ INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash)
     VALUES ('c0de0000-0000-4000-8000-000000000001', 'c1111111-1111-4111-8111-111111111111',
             'hash_probe_a', '1.0.0', 'testing', '{"logic":"a"}'::jsonb, 'probe', 'Native', true,
             'sha256:' || repeat('1', 64)) $$,
  'H2-a: a gene whose content_hash does not match sha256(phenotype::jsonb::text) still publishes'
);

-- ------------------------------------------------------------
-- H2-b: UPDATEs that touch neither content nor publish state skip the check
-- ------------------------------------------------------------
-- Two published rows sharing a hash can only exist if they predate the check,
-- so create them with the trigger off (rolled back with the file).

ALTER TABLE genes DISABLE TRIGGER trg_validate_content_hash;
INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash) VALUES
  ('c0de0000-0000-4000-8000-0000000000b1', 'c1111111-1111-4111-8111-111111111111',
   'hash_dup_1', '1.0.0', 'testing', '{"logic":"b1"}'::jsonb, 'probe', 'Native', true, 'sha256:' || repeat('b', 64)),
  ('c0de0000-0000-4000-8000-0000000000b2', 'c2222222-2222-4222-8222-222222222222',
   'hash_dup_2', '1.0.0', 'testing', '{"logic":"b2"}'::jsonb, 'probe', 'Native', true, 'sha256:' || repeat('b', 64));
ALTER TABLE genes ENABLE TRIGGER trg_validate_content_hash;

SELECT lives_ok(
  $$ UPDATE genes SET reputation_score = 0.5 WHERE id = 'c0de0000-0000-4000-8000-0000000000b1' $$,
  'H2-b: a reputation-only UPDATE on a row whose hash is shared does not re-run the duplicate check'
);

SELECT ok(
  position('IS NOT DISTINCT FROM OLD.content_hash' in pg_get_functiondef('public.validate_content_hash_on_publish()'::regprocedure)) > 0,
  'H2-b: the early-return guard from 20260601083520 is still in the function'
);

-- ------------------------------------------------------------
-- H2-c / H2-d: the duplicate check still blocks, and only for published rows
-- ------------------------------------------------------------

SELECT throws_ok(
  $$ INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash)
     VALUES ('c0de0000-0000-4000-8000-000000000002', 'c2222222-2222-4222-8222-222222222222',
             'hash_probe_c', '1.0.0', 'testing', '{"logic":"c"}'::jsonb, 'probe', 'Native', true,
             'sha256:' || repeat('1', 64)) $$,
  '23505',
  NULL,
  'H2-c: publishing a second gene with an already-published content_hash is rejected'
);

SELECT lives_ok(
  $$ INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash)
     VALUES ('c0de0000-0000-4000-8000-000000000003', 'c2222222-2222-4222-8222-222222222222',
             'hash_probe_d', '1.0.0', 'testing', '{"logic":"d"}'::jsonb, 'probe', 'Native', false,
             'sha256:' || repeat('1', 64)) $$,
  'H2-d: an unpublished gene may carry a hash a published one already has'
);

-- ------------------------------------------------------------
-- H2-e: the NULL guards are untouched
-- ------------------------------------------------------------

SELECT is(
  (SELECT count(*) FROM pg_constraint
    WHERE conname = 'chk_published_content_hash' AND conrelid = 'public.genes'::regclass)::int,
  1,
  'H2-e: chk_published_content_hash is still on genes'
);

SELECT has_trigger('genes', 'trg_require_content_hash', 'H2-e: trg_require_content_hash is still on genes');

SELECT has_trigger('genes', 'trg_validate_content_hash', 'H2-e: trg_validate_content_hash is still on genes');

-- ------------------------------------------------------------
-- H2-f: unpublish / republish are unaffected
-- ------------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"c1111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

SELECT lives_ok(
  $$ SELECT unpublish_gene('c0de0000-0000-4000-8000-000000000001', 'test');
     SELECT republish_gene('c0de0000-0000-4000-8000-000000000001', 'test') $$,
  'H2-f: the author can unpublish and republish a gene whose hash nobody else holds'
);

SELECT set_config('request.jwt.claims',
  '{"sub":"c2222222-2222-4222-8222-222222222222","role":"authenticated"}', true);

SELECT throws_ok(
  $$ SELECT unpublish_gene('c0de0000-0000-4000-8000-000000000001', 'not mine') $$,
  '42501',
  NULL,
  'H2-f: someone else cannot unpublish it'
);

SELECT * FROM finish();
ROLLBACK;
