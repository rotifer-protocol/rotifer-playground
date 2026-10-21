-- ============================================================
-- pgTAP tests for cross-author content_hash squatting
-- File: supabase/tests/content_hash_squatting.sql
-- ============================================================
--
-- ADR-341 D5 (M1). The duplicate check rejects publishing a Gene whose
-- content_hash another published Gene already holds. Because the INSERT policy
-- only checks owner_id, author B could publish anything under the hash of A's
-- unpublished Gene, and A could then never put it back (23505). Migration
-- 20261020130000:
--   1. pins genes.created_at to server time (INSERT: clock_timestamp(),
--      UPDATE: unchanged), so a client cannot claim to be earlier;
--   2. limits the duplicate check to rows created before the one being
--      written: whoever was first keeps the hash.
--
--   M1-a  the earlier author can republish over a later squatter
--   M1-b  a forged created_at, on INSERT or UPDATE, does not stick
--   M1-c  the first publisher still blocks a later one, even if the later
--         one claims an earlier created_at; the pin runs before the check
--
-- Each of M1-a/b/c fails against the function from 20261020120000 alone.
--
-- Run inside the supabase test container:
--   supabase test db

BEGIN;

SELECT plan(7);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('d1111111-1111-4111-8111-111111111111', 'first-author@example.com', '{"user_name": "first_author"}'::jsonb),
  ('d2222222-2222-4222-8222-222222222222', 'squatter@example.com',     '{"user_name": "squatter"}'::jsonb);

CREATE TEMP TABLE t0 AS SELECT clock_timestamp() AS ts;

-- ------------------------------------------------------------
-- M1-a: the earlier author can put their Gene back
-- ------------------------------------------------------------
-- A publishes, then takes it down. B, later, publishes under A's hash.

INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash) VALUES
  ('d0de0000-0000-4000-8000-0000000000a1', 'd1111111-1111-4111-8111-111111111111',
   'squat_victim_a', '1.0.0', 'testing', '{"logic":"a"}'::jsonb, 'probe', 'Native', true, repeat('a', 64));

SELECT set_config('request.jwt.claims',
  '{"sub":"d1111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
SELECT unpublish_gene('d0de0000-0000-4000-8000-0000000000a1', 'test');

INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash) VALUES
  ('d0de0000-0000-4000-8000-0000000000a2', 'd2222222-2222-4222-8222-222222222222',
   'squatter_a', '1.0.0', 'testing', '{"logic":"other"}'::jsonb, 'probe', 'Native', true, repeat('a', 64));

SELECT lives_ok(
  $$ SELECT republish_gene('d0de0000-0000-4000-8000-0000000000a1', 'back') $$,
  'M1-a: the earlier author republishes even though a later Gene took the hash'
);

-- ------------------------------------------------------------
-- M1-b: a forged created_at does not stick
-- ------------------------------------------------------------
-- C (A's) exists first, unpublished. D (B's) claims 2000-01-01.

INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash) VALUES
  ('d0de0000-0000-4000-8000-0000000000b1', 'd1111111-1111-4111-8111-111111111111',
   'squat_victim_b', '1.0.0', 'testing', '{"logic":"b"}'::jsonb, 'probe', 'Native', false, repeat('b', 64));

INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash, created_at) VALUES
  ('d0de0000-0000-4000-8000-0000000000b2', 'd2222222-2222-4222-8222-222222222222',
   'squatter_b', '1.0.0', 'testing', '{"logic":"other-b"}'::jsonb, 'probe', 'Native', true, repeat('b', 64),
   '2000-01-01T00:00:00Z');

SELECT ok(
  (SELECT created_at FROM genes WHERE id = 'd0de0000-0000-4000-8000-0000000000b2') >= (SELECT ts FROM t0),
  'M1-b: a created_at supplied on INSERT is replaced by server time'
);

UPDATE genes SET created_at = '2000-01-01T00:00:00Z' WHERE id = 'd0de0000-0000-4000-8000-0000000000b2';

SELECT ok(
  (SELECT created_at FROM genes WHERE id = 'd0de0000-0000-4000-8000-0000000000b2') >= (SELECT ts FROM t0),
  'M1-b: an UPDATE cannot move created_at back afterwards'
);

SELECT lives_ok(
  $$ SELECT republish_gene('d0de0000-0000-4000-8000-0000000000b1', 'mine first') $$,
  'M1-b: so the Gene that really came first can still be published'
);

-- ------------------------------------------------------------
-- M1-c: the first publisher still blocks a later one
-- ------------------------------------------------------------

INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash) VALUES
  ('d0de0000-0000-4000-8000-0000000000c1', 'd1111111-1111-4111-8111-111111111111',
   'first_publisher_c', '1.0.0', 'testing', '{"logic":"c"}'::jsonb, 'probe', 'Native', true, repeat('c', 64));

SELECT throws_ok(
  $$ INSERT INTO genes (id, owner_id, name, version, domain, phenotype, description, fidelity, published, content_hash, created_at)
     VALUES ('d0de0000-0000-4000-8000-0000000000c2', 'd2222222-2222-4222-8222-222222222222',
             'late_publisher_c', '1.0.0', 'testing', '{"logic":"other-c"}'::jsonb, 'probe', 'Native', true,
             repeat('c', 64), '2000-01-01T00:00:00Z') $$,
  '23505',
  NULL,
  'M1-c: a later INSERT under a published hash is rejected, even claiming an earlier created_at'
);

SELECT ok(
  (SELECT array_position(array_agg(tgname::text ORDER BY tgname), 'trg_genes_00_pin_created_at')
        < array_position(array_agg(tgname::text ORDER BY tgname), 'trg_validate_content_hash')
     FROM pg_trigger
    WHERE tgrelid = 'public.genes'::regclass AND NOT tgisinternal
      AND (tgtype & 2) = 2),  -- BEFORE triggers; same-event ones run in name order
  'M1-c: trg_genes_00_pin_created_at runs before trg_validate_content_hash'
);

SELECT has_trigger('genes', 'trg_genes_00_pin_created_at', 'M1: the pin trigger is on genes');

SELECT * FROM finish();
ROLLBACK;
