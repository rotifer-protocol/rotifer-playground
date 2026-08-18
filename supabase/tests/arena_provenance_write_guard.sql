-- ============================================================
-- pgTAP tests for enforce_arena_provenance() (ADR-319 D2, 阶段 2.2)
-- File: supabase/tests/arena_provenance_write_guard.sql
-- ============================================================
--
-- Migration 20260818160000. Both write paths POST straight to /arena_entries
-- through PostgREST, so "clients must not choose binding_runtime" is not
-- something client code can be trusted to honour — anyone with a token and
-- curl can claim it. These assertions cover the two things the server can
-- actually decide, and no more.
--
-- T3/T4 are the guard. T6 is the one that keeps the guard honest: the server
-- CANNOT tell sandbox from estimated from declared, so it must not pretend to
-- — those stay client claims, checkable only by §9.7.1 recomputation. A future
-- change that starts rejecting them here would be enforcing a distinction it
-- cannot actually see.
--
-- Role is simulated with SET LOCAL ROLE + request.jwt.claims, the same shape
-- PostgREST produces.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(7);

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('a8111111-1111-4111-8111-111111111111', 'guard-test@example.com',
        '{"user_name": "guard_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('a8222222-2222-4222-8222-222222222222',
        'a8111111-1111-4111-8111-111111111111',
        'guard-test-gene', 'test.guard', '0.1.0', 'Wrapped',
        '{"domain":"test.guard","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('9', 64));

SELECT has_function('public', 'enforce_arena_provenance', 'T1: enforce_arena_provenance() exists');
SELECT has_trigger('public', 'arena_entries', 'trg_enforce_arena_provenance',
  'T2: the guard is bound to arena_entries');

-- ------------------------------------------------------------
-- As a client (PostgREST shape: role=authenticated + a jwt sub claim)
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a8111111-1111-4111-8111-111111111111","role":"authenticated"}';

-- T3 — the claim a client must not be able to make
SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
     VALUES ('a8222222-2222-4222-8222-222222222222', 'test.guard', 0.9, 'binding_runtime') $$,
  '42501',
  NULL,
  'T3: a client claiming binding_runtime is refused');

-- T4 — a client claim the server can accept, and the identity it stamps
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, evaluator)
     VALUES ('a8222222-2222-4222-8222-222222222222', 'test.guard', 0.5, 'sandbox', 'someone-else') $$,
  'T4: a sandbox claim from a client is accepted');
SELECT is(
  (SELECT evaluator FROM arena_entries WHERE gene_id = 'a8222222-2222-4222-8222-222222222222'),
  'a8111111-1111-4111-8111-111111111111',
  'T5: evaluator is stamped from the authenticated principal, overwriting what the client sent');

-- T6 — the server does NOT adjudicate between client-asserted methods
SELECT lives_ok(
  $$ UPDATE arena_entries SET evaluation_method = 'declared'
      WHERE gene_id = 'a8222222-2222-4222-8222-222222222222' $$,
  'T6: sandbox/estimated/declared remain client claims — the guard does not police what it cannot verify');

RESET ROLE;
RESET request.jwt.claims;

-- ------------------------------------------------------------
-- Server-side (no client JWT): the binding may attest
-- ------------------------------------------------------------
SELECT lives_ok(
  $$ UPDATE arena_entries SET evaluation_method = 'binding_runtime', evaluator = 'binding:cloud-runtime'
      WHERE gene_id = 'a8222222-2222-4222-8222-222222222222' $$,
  'T7: a server-side session may attest binding_runtime and name a binding as evaluator');

SELECT * FROM finish();

ROLLBACK;
