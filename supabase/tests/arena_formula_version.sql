-- ============================================================
-- pgTAP tests for arena_entries.formula_version
-- (migration 20261027200000, ADR-346 D5, T-107)
-- File: supabase/tests/arena_formula_version.sql
-- ============================================================
--
--   V1  the column exists and is nullable
--   V2  a client request without the version header writes NULL
--   V3  with the header, the guard records that version
--   V4  an older CLI re-submitting after a newer one clears the label
--   V5  a newer CLI re-submitting labels the row again
--   V6  a header that is not a version reads as undeclared
--   V7  the client cannot write the column itself, on insert or update
--   V8  the CHECK still refuses what cannot be a version (server writes)
--   V9  the guard's other rules still hold (one per rule family checked
--       here; arena_effective_fidelity.sql and arena_write_hardening.sql
--       run against the same replaced guard)
--   V10 anon writes nothing
--
-- Written as PostgREST writes: SET LOCAL ROLE + request.jwt.claims, and the
-- request headers as PostgREST passes them (request.headers, a JSON object
-- with lowercase names), so the column privileges, RLS and
-- guard_arena_entry_client_write all apply.
--
-- Every client row carries what the guard requires of a submission
-- (base_fitness and fidelity_discount, fitness_value = base × discount, the
-- gene's domain, the Wrapped discount 0.70), so each assertion reaches the
-- rule it names and not an earlier one.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(22);

-- ── Fixtures (written as the test role: server-side, no guard) ──

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f7111111-1111-4111-8111-111111111111', 'fv-a@example.com', '{"user_name": "fv_a"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f71a0000-0000-4000-8000-00000000000a', 'f7111111-1111-4111-8111-111111111111', 'fv-one',   'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('a', 64)),
  ('f71b0000-0000-4000-8000-00000000000b', 'f7111111-1111-4111-8111-111111111111', 'fv-two',   'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('b', 64)),
  ('f71c0000-0000-4000-8000-00000000000c', 'f7111111-1111-4111-8111-111111111111', 'fv-three', 'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('c', 64)),
  ('f71d0000-0000-4000-8000-00000000000d', 'f7111111-1111-4111-8111-111111111111', 'fv-four',  'test.fv', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('d', 64));

-- ── V1 ──────────────────────────────────────────────────────

SELECT has_column('public', 'arena_entries', 'formula_version', 'V1a: arena_entries has formula_version');
SELECT col_is_null('public', 'arena_entries', 'formula_version', 'V1b: and it is nullable (rows before it existed)');

-- ── V8 (the test's own role, no request claims: a server-side writer,
-- which the guard lets through) ──────────────────────────────

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, formula_version)
     VALUES ('f71d0000-0000-4000-8000-00000000000d', 'test.fv', 0.35, 'estimated', 0) $$,
  '23514', NULL,
  'V8: 0 is not a formula version');

-- ── As an authenticated client ──────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f7111111-1111-4111-8111-111111111111","role":"authenticated"}';

-- V2: no request.headers at all yet in this transaction, as a CLI before
-- ADR-346 sends none of ours.
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71c0000-0000-4000-8000-00000000000c', 'test.fv', 0.35, 0.5, 0.70, 'estimated') $$,
  'V2a: a submission without the version header is accepted');
SELECT is(
  (SELECT formula_version FROM arena_entries WHERE gene_id = 'f71c0000-0000-4000-8000-00000000000c'),
  NULL,
  'V2b: and records no version');

-- V3
SET LOCAL request.headers = '{"x-rotifer-formula-version":"3"}';
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71a0000-0000-4000-8000-00000000000a', 'test.fv', 0.35, 0.5, 0.70, 'estimated') $$,
  'V3a: a submission with x-rotifer-formula-version: 3 is accepted');
SELECT is(
  (SELECT formula_version::int FROM arena_entries WHERE gene_id = 'f71a0000-0000-4000-8000-00000000000a'),
  3,
  'V3b: and the guard records version 3');

-- V4: the CLI's upsert (on_conflict=gene_id, merge-duplicates sets only the
-- columns sent), from a CLI that sends no version header.
SET LOCAL request.headers = '{}';
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71a0000-0000-4000-8000-00000000000a', 'test.fv', 0.49, 0.7, 0.70, 'estimated')
     ON CONFLICT (gene_id) DO UPDATE
       SET fitness_value = EXCLUDED.fitness_value,
           base_fitness = EXCLUDED.base_fitness,
           fidelity_discount = EXCLUDED.fidelity_discount,
           evaluation_method = EXCLUDED.evaluation_method $$,
  'V4a: an older CLI re-submits the same gene');
SELECT is(
  (SELECT round(fitness_value::numeric, 6) FROM arena_entries WHERE gene_id = 'f71a0000-0000-4000-8000-00000000000a'),
  0.49::numeric,
  'V4b: its score replaces the newer one');
SELECT is(
  (SELECT formula_version FROM arena_entries WHERE gene_id = 'f71a0000-0000-4000-8000-00000000000a'),
  NULL,
  'V4c: and the version 3 label is cleared, not left on an old-scale score');

-- V5
SET LOCAL request.headers = '{"x-rotifer-formula-version":"3"}';
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71a0000-0000-4000-8000-00000000000a', 'test.fv', 0.35, 0.5, 0.70, 'estimated')
     ON CONFLICT (gene_id) DO UPDATE
       SET fitness_value = EXCLUDED.fitness_value,
           base_fitness = EXCLUDED.base_fitness,
           fidelity_discount = EXCLUDED.fidelity_discount,
           evaluation_method = EXCLUDED.evaluation_method $$,
  'V5a: a newer CLI re-submits');
SELECT is(
  (SELECT formula_version::int FROM arena_entries WHERE gene_id = 'f71a0000-0000-4000-8000-00000000000a'),
  3,
  'V5b: and the row is labelled 3 again');

-- V6
SET LOCAL request.headers = '{"x-rotifer-formula-version":"0"}';
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71b0000-0000-4000-8000-00000000000b', 'test.fv', 0.35, 0.5, 0.70, 'estimated') $$,
  'V6a: a header of 0 does not refuse the score');
SELECT is(
  (SELECT formula_version FROM arena_entries WHERE gene_id = 'f71b0000-0000-4000-8000-00000000000b'),
  NULL,
  'V6b: and records no version');
-- Labelled 3 first, so V6c tells "cleared" apart from "left as it was".
SET LOCAL request.headers = '{"x-rotifer-formula-version":"3"}';
UPDATE arena_entries SET fitness_value = 0.42, base_fitness = 0.6
 WHERE gene_id = 'f71b0000-0000-4000-8000-00000000000b';
SELECT is(
  (SELECT formula_version::int FROM arena_entries WHERE gene_id = 'f71b0000-0000-4000-8000-00000000000b'),
  3,
  'V6c: a plain client UPDATE is labelled from the header too');
SET LOCAL request.headers = '{"x-rotifer-formula-version":"3.5"}';
UPDATE arena_entries SET fitness_value = 0.28, base_fitness = 0.4
 WHERE gene_id = 'f71b0000-0000-4000-8000-00000000000b';
SELECT is(
  (SELECT round(fitness_value::numeric, 6)::text || ' / ' || coalesce(formula_version::text, 'null')
     FROM arena_entries WHERE gene_id = 'f71b0000-0000-4000-8000-00000000000b'),
  '0.280000 / null',
  'V6d: a header that is not a whole number reads as undeclared');

-- V7: the value comes from the header only; the column is not in the
-- client's GRANT list, so a body value is refused before the guard runs.
SET LOCAL request.headers = '{"x-rotifer-formula-version":"3"}';
SELECT throws_like(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method, formula_version)
     VALUES ('f71d0000-0000-4000-8000-00000000000d', 'test.fv', 0.35, 0.5, 0.70, 'estimated', 3) $$,
  '%permission denied%',
  'V7a: a client cannot send formula_version in the row');
SELECT throws_like(
  $$ UPDATE arena_entries SET formula_version = 2
      WHERE gene_id = 'f71a0000-0000-4000-8000-00000000000a' $$,
  '%permission denied%',
  'V7b: nor set it on an existing row');

-- V9: the other rules of the guard, with a valid version header present.
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
     VALUES ('f71d0000-0000-4000-8000-00000000000d', 'test.fv', 0.35, 'estimated') $$,
  '42501', 'arena_entries: a client submission carries base_fitness and fidelity_discount (spec §5.1 dual column)',
  'V9a: a submission without the dual columns is still refused');
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71d0000-0000-4000-8000-00000000000d', 'test.fv', 0.5, 0.5, 1.00, 'estimated') $$,
  '42501', NULL,
  'V9b: a discount above the gene''s declared tier is still refused');
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71d0000-0000-4000-8000-00000000000d', 'test.other', 0.35, 0.5, 0.70, 'estimated') $$,
  '42501', NULL,
  'V9c: a domain other than the gene''s is still refused');

RESET ROLE;

-- ── V10 ─────────────────────────────────────────────────────

SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('f71d0000-0000-4000-8000-00000000000d', 'test.fv', 0.35, 0.5, 0.70, 'estimated') $$,
  '42501', NULL,
  'V10: anon cannot write');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
