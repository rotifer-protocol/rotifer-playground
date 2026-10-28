-- ============================================================
-- pgTAP tests for arena_entries.formula_version
-- (migration 20261027200000, ADR-345 D5, T-107)
-- File: supabase/tests/arena_formula_version.sql
-- ============================================================
--
--   V1  the column exists and is nullable
--   V2  a client can send it, on insert and on the CLI's upsert
--   V3  a client that does not send it (CLI before ADR-345) writes NULL
--   V4  a value that cannot be a version is refused
--   V5  anon writes nothing
--
-- Written as PostgREST writes: SET LOCAL ROLE + request.jwt.claims, so the
-- column privileges, RLS and guard_arena_entry_client_write all apply.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(9);

-- ── Fixtures (written as the test role: server-side, no guard) ──

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f7111111-1111-4111-8111-111111111111', 'fv-a@example.com', '{"user_name": "fv_a"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f71a0000-0000-4000-8000-00000000000a', 'f7111111-1111-4111-8111-111111111111', 'fv-one',   'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('a', 64)),
  ('f71b0000-0000-4000-8000-00000000000b', 'f7111111-1111-4111-8111-111111111111', 'fv-two',   'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('b', 64)),
  ('f71c0000-0000-4000-8000-00000000000c', 'f7111111-1111-4111-8111-111111111111', 'fv-three', 'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('c', 64));

-- ── V1 ──────────────────────────────────────────────────────

SELECT has_column('public', 'arena_entries', 'formula_version', 'V1a: arena_entries has formula_version');
SELECT col_is_null('public', 'arena_entries', 'formula_version', 'V1b: and it is nullable (rows before it existed)');

-- ── V2–V4, as an authenticated client ───────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f7111111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, formula_version)
     VALUES ('f71a0000-0000-4000-8000-00000000000a', 'test.fv', 0.3, 'estimated', 3) $$,
  'V2a: a client can send formula_version');

SELECT is(
  (SELECT formula_version::int FROM arena_entries WHERE gene_id = 'f71a0000-0000-4000-8000-00000000000a'),
  3,
  'V2b: and it is stored');

-- The CLI upserts (on_conflict=gene_id, merge-duplicates), which needs UPDATE
-- on every column sent.
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, formula_version)
     VALUES ('f71a0000-0000-4000-8000-00000000000a', 'test.fv', 0.4, 'estimated', 3)
     ON CONFLICT (gene_id) DO UPDATE
       SET fitness_value = EXCLUDED.fitness_value, formula_version = EXCLUDED.formula_version $$,
  'V2c: the CLI''s upsert can re-send it');

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
     VALUES ('f71b0000-0000-4000-8000-00000000000b', 'test.fv', 0.3, 'estimated') $$,
  'V3a: a client that does not send it still writes');

SELECT is(
  (SELECT formula_version FROM arena_entries WHERE gene_id = 'f71b0000-0000-4000-8000-00000000000b'),
  NULL,
  'V3b: and the row records no version');

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, formula_version)
     VALUES ('f71c0000-0000-4000-8000-00000000000c', 'test.fv', 0.3, 'estimated', 0) $$,
  '23514', NULL,
  'V4: 0 is not a formula version');

RESET ROLE;

-- ── V5 ──────────────────────────────────────────────────────

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, formula_version)
     VALUES ('f71c0000-0000-4000-8000-00000000000c', 'test.fv', 0.3, 'estimated', 3) $$,
  '42501', NULL,
  'V5: anon cannot write it');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
