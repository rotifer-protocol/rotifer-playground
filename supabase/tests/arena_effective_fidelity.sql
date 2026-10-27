-- ============================================================
-- pgTAP tests for a lower fidelity tier on client submissions
-- (migration 20261027100000, T-100)
-- File: supabase/tests/arena_effective_fidelity.sql
-- ============================================================
--
-- The CLI discounts by the tier a gene earned on this run (playground #471):
-- a declared Native that did not run in the sandbox is scored as Wrapped.
-- The write guard only accepted the declared tier's discount, so that score
-- could not be submitted at all. Now a submission may report any §5.1 tier at
-- or below the declared one, never above it, and the server records which
-- tier it was in effective_fidelity.
--
--   E1  a lower tier is accepted, and recorded
--   E2  a higher tier is refused, and says why
--   E3  what a client before 0.31.0 sends is accepted as before
--   E4  anon writes nothing, whichever tier it sends
--
-- Two ways of writing as a client, as in arena_write_hardening.sql:
-- SET LOCAL ROLE + request.jwt.claims (what PostgREST does: privileges, RLS,
-- then the triggers), and request.jwt.claims alone as the test's own role
-- (the guard on its own, without the column privileges).
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(20);

-- ── Fixtures (written as the test role: server-side, no guard) ──

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('e7111111-1111-4111-8111-111111111111', 'eff-a@example.com', '{"user_name": "eff_a"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('e71a0000-0000-4000-8000-00000000000a', 'e7111111-1111-4111-8111-111111111111', 'eff-native',   'test.eff', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('1', 64)),
  ('e71b0000-0000-4000-8000-00000000000b', 'e7111111-1111-4111-8111-111111111111', 'eff-native-2', 'test.eff', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('2', 64)),
  ('e71c0000-0000-4000-8000-00000000000c', 'e7111111-1111-4111-8111-111111111111', 'eff-wrapped',  'test.eff', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('3', 64)),
  ('e71d0000-0000-4000-8000-00000000000d', 'e7111111-1111-4111-8111-111111111111', 'eff-hybrid',   'test.eff', '0.1.0', 'Hybrid',  '{}'::jsonb, true, repeat('4', 64)),
  ('e71e0000-0000-4000-8000-00000000000e', 'e7111111-1111-4111-8111-111111111111', 'eff-native-3', 'test.eff', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('5', 64)),
  ('e71f0000-0000-4000-8000-00000000000f', 'e7111111-1111-4111-8111-111111111111', 'eff-native-4', 'test.eff', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('6', 64));

-- ── E1: a lower tier is accepted ────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"e7111111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71a0000-0000-4000-8000-00000000000a', 'test.eff', 0.35, 0.5, 0.70, 'estimated') $$,
  'E1a: a declared Native submitted at the Wrapped discount (did not run in the sandbox) is accepted');

SELECT is(
  (SELECT effective_fidelity FROM arena_entries WHERE gene_id = 'e71a0000-0000-4000-8000-00000000000a'),
  'Wrapped',
  'E1b: the row records the tier it was scored at');

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71d0000-0000-4000-8000-00000000000d', 'test.eff', 0.35, 0.5, 0.70, 'estimated') $$,
  'E1c: a declared Hybrid may report Wrapped too');

SELECT is(
  (SELECT effective_fidelity FROM arena_entries WHERE gene_id = 'e71d0000-0000-4000-8000-00000000000d'),
  'Wrapped',
  'E1d: and is recorded as Wrapped');

-- A client cannot write the column itself: it is the server's reading of the
-- discount, not a second claim (no column privilege)...
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method, effective_fidelity)
     VALUES ('e71e0000-0000-4000-8000-00000000000e', 'test.eff', 0.35, 0.5, 0.70, 'estimated', 'Native') $$,
  '42501', NULL,
  'E1e: through PostgREST, a client cannot write effective_fidelity');

RESET ROLE;

-- ...and where the privilege is not in the way, the guard overwrites it.
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method, effective_fidelity)
     VALUES ('e71e0000-0000-4000-8000-00000000000e', 'test.eff', 0.35, 0.5, 0.70, 'estimated', 'Native') $$,
  'E1f: the guard alone takes the write');

SELECT is(
  (SELECT effective_fidelity FROM arena_entries WHERE gene_id = 'e71e0000-0000-4000-8000-00000000000e'),
  'Wrapped',
  'E1g: and records the tier the discount says, not the one the client named');

-- ── E2: a higher tier is refused ────────────────────────────

SET LOCAL ROLE authenticated;

SELECT throws_like(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71c0000-0000-4000-8000-00000000000c', 'test.eff', 0.5, 0.5, 1.00, 'estimated') $$,
  '%above the gene''s declared fidelity Wrapped%',
  'E2a: a declared Wrapped cannot claim the Native discount, and is told why');

SELECT throws_like(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71c0000-0000-4000-8000-00000000000c', 'test.eff', 0.425, 0.5, 0.85, 'estimated') $$,
  '%above the gene''s declared fidelity Wrapped%',
  'E2b: nor the Hybrid discount');

SELECT throws_like(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71b0000-0000-4000-8000-00000000000b', 'test.eff', 0.45, 0.5, 0.90, 'estimated') $$,
  '%is not a spec §5.1 discount%',
  'E2c: a discount that is no tier''s is refused');

SELECT throws_like(
  $$ UPDATE arena_entries SET fidelity_discount = 1.00, fitness_value = 0.5
      WHERE gene_id = 'e71d0000-0000-4000-8000-00000000000d' $$,
  '%above the gene''s declared fidelity Hybrid%',
  'E2d: a re-submission cannot raise a Hybrid to Native');

SELECT ok(
  NOT EXISTS (SELECT 1 FROM arena_entries WHERE gene_id IN ('e71c0000-0000-4000-8000-00000000000c', 'e71b0000-0000-4000-8000-00000000000b'))
  AND (SELECT fidelity_discount FROM arena_entries WHERE gene_id = 'e71d0000-0000-4000-8000-00000000000d') = 0.70,
  'E2e: nothing refused was written');

RESET ROLE;

SELECT throws_like(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71c0000-0000-4000-8000-00000000000c', 'test.eff', 0.5, 0.5, 1.00, 'estimated') $$,
  '%above the gene''s declared fidelity Wrapped%',
  'E2f: the guard alone refuses it (without the column privileges)');

-- ── E3: what a client before 0.31.0 sends ───────────────────

SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71b0000-0000-4000-8000-00000000000b', 'test.eff', 0.5, 0.5, 1.00, 'estimated') $$,
  'E3a: the declared tier''s discount, without effective_fidelity, is accepted as before');

SELECT is(
  (SELECT effective_fidelity FROM arena_entries WHERE gene_id = 'e71b0000-0000-4000-8000-00000000000b'),
  'Native',
  'E3b: and recorded as the declared tier');

SELECT lives_ok(
  $$ UPDATE arena_entries SET fidelity_discount = 1.00, fitness_value = 0.5, base_fitness = 0.5
      WHERE gene_id = 'e71a0000-0000-4000-8000-00000000000a' $$,
  'E3c: an older client re-submitting at the declared tier over a lower-tier row is accepted');

SELECT is(
  (SELECT effective_fidelity FROM arena_entries WHERE gene_id = 'e71a0000-0000-4000-8000-00000000000a'),
  'Native',
  'E3d: and the row follows it (the column is the server''s, so nothing stale is left behind)');

RESET ROLE;

-- ── E4: anon writes nothing ─────────────────────────────────

SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71f0000-0000-4000-8000-00000000000f', 'test.eff', 0.35, 0.5, 0.70, 'estimated') $$,
  '42501', NULL,
  'E4a: through PostgREST, anon cannot submit');

RESET ROLE;

SELECT throws_like(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('e71f0000-0000-4000-8000-00000000000f', 'test.eff', 0.5, 0.5, 1.00, 'estimated') $$,
  '%anon%',
  'E4b: the guard alone refuses anon too, so a later grant to anon would not open the table');

SELECT ok(
  NOT EXISTS (SELECT 1 FROM arena_entries WHERE gene_id = 'e71f0000-0000-4000-8000-00000000000f'),
  'E4c: no row was written');

SELECT * FROM finish();
ROLLBACK;
