-- ============================================================
-- pgTAP tests for arena_evaluation_runs (ADR-319 D3, 阶段 2.3)
-- File: supabase/tests/arena_evaluation_runs.sql
-- ============================================================
--
-- Migration 20260818170000. This table exists so that "recompute the rankings
-- yourself" is a thing a person can actually do, rather than a promise in
-- §9.7.1 with no data behind it.
--
-- The assertions that carry weight are T6 and T7. Public read is the whole
-- point — evidence nobody may read is not evidence. And the absence of UPDATE
-- and DELETE policies is deliberate: a measurement that was taken cannot be
-- revised, only superseded by a later submission. T7 pins that, because the
-- easy way to "fix" an embarrassing score later is to edit it, and this table
-- must not offer that door.
--
-- T4 pins that output_schema_valid tolerates NULL, which means "there was
-- nothing to check" — not "it passed". Losing that distinction would make an
-- unvalidatable Gene look identical to a compliant one.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(12);

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('b9111111-1111-4111-8111-111111111111', 'runs-test@example.com',
        '{"user_name": "runs_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('b9222222-2222-4222-8222-222222222222',
        'b9111111-1111-4111-8111-111111111111',
        'runs-test-gene', 'test.runs', '0.1.0', 'Wrapped',
        '{"domain":"test.runs","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('8', 64));

SELECT has_table('public', 'arena_evaluation_runs', 'T1: arena_evaluation_runs exists');

-- T2 — the shape a recomputation needs: both failure modes, plus cost inputs
SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9333333-3333-4333-8333-333333333333', 0, true, true, 12.5, 4200) $$,
  'T2: a measured run is recorded');

-- T3 — the two failure modes stay distinguishable
SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9333333-3333-4333-8333-333333333333', 1, true, false, 9.0, 3900) $$,
  'T3: "ran but violated its own schema" is recordable, distinct from a crash');

-- T4 — nothing to check is not the same as passed
SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9333333-3333-4333-8333-333333333333', 2, false, NULL, 0, 0) $$,
  'T4: output_schema_valid accepts NULL — nothing to check is its own state');

-- T5 — one submission cannot record the same run twice
SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9333333-3333-4333-8333-333333333333', 0, true, 1, 1) $$,
  '23505',
  NULL,
  'T5: a duplicate run_index within a submission is rejected');

-- T6 — the evidence is public, or the promise to recompute is empty
SELECT policies_are(
  'public', 'arena_evaluation_runs',
  ARRAY['Evaluation runs are publicly readable', 'Signed-in callers may record evaluation runs'],
  'T6: exactly two policies — public read, signed-in insert');

-- T7 — append-only: there is no door to edit history
SELECT is(
  (SELECT count(*) FROM pg_policies
    WHERE tablename = 'arena_evaluation_runs' AND cmd IN ('UPDATE', 'DELETE')),
  0::bigint,
  'T7: no UPDATE or DELETE policy exists — a measurement is superseded, never revised');

-- T8 — RLS must be on. Supabase grants every privilege to anon by default, so
-- without RLS the policies above are decoration and anon could delete the
-- ledger. This asserts the layer that is actually load-bearing.
SELECT is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.arena_evaluation_runs'::regclass),
  true,
  'T8: RLS is enabled — the default grants would otherwise leave the evidence deletable');

-- T9 — negative measurements are not measurements
SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9444444-4444-4444-8444-444444444444', 0, true, -1, 1) $$,
  '23514',
  NULL,
  'T9: a negative latency is rejected');

-- T10 — the second layer: the privileges themselves are gone, so the ledger
-- survives even a future migration that turns RLS off by accident.
SELECT is(
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_name = 'arena_evaluation_runs'
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')),
  0::bigint,
  'T10: UPDATE/DELETE/TRUNCATE are revoked outright, not merely unpolicied');

-- T11 — failure_kind accepts the four vocabulary values and NULL (plan 2.12).
-- NULL is load-bearing: it means "successful run" or "row predating the
-- column", never a fifth kind.
SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost, failure_kind)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9555555-5555-4555-8555-555555555555', 0, false, 12.5, 500000000, 'fuel-exhausted') $$,
  'T11: fuel-exhausted is a recordable failure kind');

-- T12 — a made-up kind is rejected: the vocabulary is the contract, and a
-- client inventing "oom-ish" must fail loudly rather than pollute the ledger.
SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs
       (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost, failure_kind)
     VALUES ('b9222222-2222-4222-8222-222222222222',
             'b9555555-5555-4555-8555-555555555555', 1, false, 12.5, 1, 'oom-ish') $$,
  '23514',
  NULL,
  'T12: an unknown failure kind is rejected');

SELECT * FROM finish();

ROLLBACK;
