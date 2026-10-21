-- ============================================================
-- pgTAP tests for Arena write hardening (migration 20261021200000)
-- File: supabase/tests/arena_write_hardening.sql
-- ============================================================
--
-- What a client may write to arena_entries and arena_evaluation_runs
-- (T-58 audit §5, P1–P16; P18 is the regression the current CLI depends
-- on). P17 (reference-scale CHECK) is out of scope for this migration.
-- P8 follows the user's 2026-10-21 decision: a client 'sandbox' is recorded
-- as 'estimated', silently.
--
-- Two ways of writing as a client, on purpose:
--   * SET LOCAL ROLE authenticated + request.jwt.claims — what PostgREST
--     does. Column privileges and RLS apply, then the triggers.
--   * request.jwt.claims alone, as the test's own (superuser) role — the
--     triggers still see a client (auth.role() reads the claims), but
--     privileges and RLS do not apply. This checks the guard on its own, so
--     the test would still catch it if the column privileges were dropped.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(37);

-- ── Fixtures (written as the test role: server-side, no guard) ──

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('d5811111-1111-4111-8111-111111111111', 'harden-a@example.com', '{"user_name": "harden_a"}'::jsonb),
  ('d5822222-2222-4222-8222-222222222222', 'harden-b@example.com', '{"user_name": "harden_b"}'::jsonb);

-- Author A: gA (row, invalidated), gB (row), gC (no row), gW (Wrapped, no row).
-- Author B: gV (row, client self-report), gR (row, binding_runtime).
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('d58a0000-0000-4000-8000-00000000000a', 'd5811111-1111-4111-8111-111111111111', 'harden-a', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('1', 64)),
  ('d58b0000-0000-4000-8000-00000000000b', 'd5811111-1111-4111-8111-111111111111', 'harden-b', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('2', 64)),
  ('d58c0000-0000-4000-8000-00000000000c', 'd5811111-1111-4111-8111-111111111111', 'harden-c', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('3', 64)),
  ('d58d0000-0000-4000-8000-00000000000d', 'd5811111-1111-4111-8111-111111111111', 'harden-w', 'test.harden', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('4', 64)),
  ('d58e0000-0000-4000-8000-00000000000e', 'd5822222-2222-4222-8222-222222222222', 'harden-v', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('5', 64)),
  ('d58f0000-0000-4000-8000-00000000000f', 'd5822222-2222-4222-8222-222222222222', 'harden-r', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('6', 64)),
  -- One gene per refused insert, so that against the old schema (where those
  -- inserts succeed) no later test trips over a row an earlier one left.
  ('d58c0000-0000-4000-8000-0000000000c2', 'd5811111-1111-4111-8111-111111111111', 'harden-c2', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('7', 64)),
  ('d58c0000-0000-4000-8000-0000000000c3', 'd5811111-1111-4111-8111-111111111111', 'harden-c3', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('8', 64)),
  ('d58c0000-0000-4000-8000-0000000000c4', 'd5811111-1111-4111-8111-111111111111', 'harden-c4', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('9', 64)),
  ('d58c0000-0000-4000-8000-0000000000c5', 'd5811111-1111-4111-8111-111111111111', 'harden-c5', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('c', 64)),
  ('d58f0000-0000-4000-8000-0000000000f2', 'd5822222-2222-4222-8222-222222222222', 'harden-r2', 'test.harden', '0.1.0', 'Native',  '{}'::jsonb, true, repeat('d', 64)),
  ('d58d0000-0000-4000-8000-0000000000d2', 'd5811111-1111-4111-8111-111111111111', 'harden-w2', 'test.harden', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('a', 64)),
  ('d58d0000-0000-4000-8000-0000000000d3', 'd5811111-1111-4111-8111-111111111111', 'harden-w3', 'test.harden', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('b', 64));

INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, evaluator, invalidated_at, invalidation_reason) VALUES
  ('d58a0000-0000-4000-8000-00000000000a', 'test.harden', 0.5, 'estimated', 'd5811111-1111-4111-8111-111111111111', now(), 'test-data'),
  ('d58b0000-0000-4000-8000-00000000000b', 'test.harden', 0.4, 'estimated', 'd5811111-1111-4111-8111-111111111111', NULL, NULL),
  ('d58e0000-0000-4000-8000-00000000000e', 'test.harden', 0.3, 'estimated', 'd5822222-2222-4222-8222-222222222222', NULL, NULL),
  ('d58f0000-0000-4000-8000-00000000000f', 'test.harden', 0.6, 'binding_runtime', 'binding', NULL, NULL),
  ('d58f0000-0000-4000-8000-0000000000f2', 'test.harden', 0.6, 'binding_runtime', 'binding', NULL, NULL);

CREATE TEMP TABLE before_reputation AS
  SELECT id, reputation_score FROM genes WHERE id = 'd58a0000-0000-4000-8000-00000000000a';
GRANT SELECT ON before_reputation TO authenticated;

-- ── P1: an author cannot clear an invalidation ──────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"d5811111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT throws_ok(
  $$ UPDATE arena_entries SET invalidated_at = NULL, invalidation_reason = NULL
      WHERE gene_id = 'd58a0000-0000-4000-8000-00000000000a' $$,
  '42501', NULL,
  'P1a: through PostgREST, an author cannot clear the invalidation on their own row');

RESET ROLE;

SELECT throws_ok(
  $$ UPDATE arena_entries SET invalidated_at = NULL, invalidation_reason = NULL
      WHERE gene_id = 'd58a0000-0000-4000-8000-00000000000a' $$,
  '42501', NULL,
  'P1b: the guard alone refuses it (without the column privileges)');

SELECT ok(
  (SELECT a.invalidation_reason = 'test-data'
          AND g.reputation_score IS NOT DISTINCT FROM b.reputation_score
     FROM arena_entries a JOIN genes g ON g.id = a.gene_id JOIN before_reputation b ON b.id = g.id
    WHERE a.gene_id = 'd58a0000-0000-4000-8000-00000000000a'),
  'P1c: the row stays invalidated and the reputation is not recomputed');

-- ── P2: nor bring one along on insert ───────────────────────

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, invalidated_at, invalidation_reason)
     VALUES ('d58c0000-0000-4000-8000-0000000000c2', 'test.harden', 0.5, 'estimated', now(), 'test-data') $$,
  '42501', NULL,
  'P2: a client insert carrying an invalidation is refused');

-- ── P3, P4: identity and the counter are the server's ───────

SELECT throws_ok(
  $$ UPDATE arena_entries SET gene_id = 'd58c0000-0000-4000-8000-0000000000c5'
      WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b' $$,
  '42501', NULL,
  'P3: an author cannot move a row to another of their genes');

SELECT throws_ok(
  $$ UPDATE arena_entries SET total_calls = 999
      WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b' $$,
  '42501', NULL,
  'P4a: nor set total_calls');

SELECT throws_ok(
  $$ UPDATE arena_entries SET created_at = '2000-01-01'
      WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b' $$,
  '42501', NULL,
  'P4b: nor created_at');

SELECT throws_ok(
  $$ UPDATE arena_entries SET id = gen_random_uuid()
      WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b' $$,
  '42501', NULL,
  'P4c: nor id');

SET LOCAL ROLE authenticated;

-- ── P5: the domain is the gene's ────────────────────────────

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
     VALUES ('d58c0000-0000-4000-8000-0000000000c3', 'other.board', 0.5, 'estimated') $$,
  '42501', NULL,
  'P5a: a submission under a domain other than the gene''s is refused');

SELECT throws_ok(
  $$ UPDATE arena_entries SET domain = 'other.board'
      WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b' $$,
  '42501', NULL,
  'P5b: so is moving a row to another domain');

-- ── P6: a binding_runtime row is not the author's to edit ───

SET LOCAL request.jwt.claims = '{"sub":"d5822222-2222-4222-8222-222222222222","role":"authenticated"}';

SELECT throws_ok(
  $$ UPDATE arena_entries SET fitness_value = 0.99, evaluation_method = 'estimated'
      WHERE gene_id = 'd58f0000-0000-4000-8000-0000000000f2' $$,
  '42501', NULL,
  'P6: the gene''s author cannot overwrite its binding_runtime measurement');

SET LOCAL request.jwt.claims = '{"sub":"d5811111-1111-4111-8111-111111111111","role":"authenticated"}';

-- ── P7: the fidelity discount is the protocol's ─────────────

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('d58d0000-0000-4000-8000-00000000000d', 'test.harden', 0.8, 0.8, 1.0, 'estimated') $$,
  '42501', NULL,
  'P7a: a Wrapped gene claiming Native''s discount (1.00) is refused');

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('d58d0000-0000-4000-8000-0000000000d2', 'test.harden', 0.9, 0.8, 0.7, 'estimated') $$,
  '42501', NULL,
  'P7b: a fitness_value that is not base_fitness × fidelity_discount is refused');

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
     VALUES ('d58d0000-0000-4000-8000-0000000000d3', 'test.harden', 0.8 * 0.7, 0.8, 0.7, 'estimated') $$,
  'P7c: the Wrapped discount (0.70, spec §5.1) with a consistent fitness_value is accepted');

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
     VALUES ('d58c0000-0000-4000-8000-0000000000c4', 'test.harden', 0.5, 'unknown-legacy') $$,
  '42501', NULL,
  'P7d: a client cannot write unknown-legacy (the backfill''s marker)');

-- ── P8: a client cannot claim 'sandbox' ─────────────────────

INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
VALUES ('d58c0000-0000-4000-8000-00000000000c', 'test.harden', 0.5, 'sandbox');
SELECT is(
  (SELECT evaluation_method FROM arena_entries WHERE gene_id = 'd58c0000-0000-4000-8000-00000000000c'),
  'estimated',
  'P8a: a client insert claiming sandbox is recorded as estimated, without an error');

UPDATE arena_entries SET evaluation_method = 'sandbox'
 WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b';
SELECT is(
  (SELECT evaluation_method FROM arena_entries WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b'),
  'estimated',
  'P8b: a client update from estimated to sandbox leaves it estimated');

-- P18 submits gC from scratch.
RESET ROLE;
DELETE FROM arena_entries WHERE gene_id = 'd58c0000-0000-4000-8000-00000000000c';

-- ── P9: privileges, the second line ─────────────────────────

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.arena_entries', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.arena_entries', 'TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.arena_entries', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.arena_entries', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.arena_entries', 'DELETE'),
  'P9a: anon and authenticated hold no table-level write privileges on arena_entries');

SELECT ok(
  (SELECT bool_and(NOT has_column_privilege('authenticated', 'public.arena_entries', c, p))
     FROM unnest(ARRAY['invalidated_at', 'invalidation_reason', 'total_calls', 'evaluator',
                       'last_evaluated', 'created_at', 'id', 'updated_at']) AS c,
          unnest(ARRAY['INSERT', 'UPDATE']) AS p),
  'P9b: authenticated can neither insert nor update the server-owned columns');

SELECT ok(
  (SELECT bool_and(has_column_privilege('authenticated', 'public.arena_entries', c, p))
     FROM unnest(ARRAY['gene_id', 'domain', 'fitness_value', 'safety_score', 'success_rate',
                       'latency_score', 'resource_efficiency', 'evaluation_method', 'evaluation_n',
                       'base_fitness', 'fidelity_discount', 'fitness_reference', 'l_ref_ms', 'cost_ref']) AS c,
          unnest(ARRAY['INSERT', 'UPDATE']) AS p),
  'P9c: ...and can insert and update the 14 columns a submission sends');

-- ── P10, P11: a call-count bump is not the caller's write ───

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"d5811111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT log_mcp_call('harden_probe', 'd58e0000-0000-4000-8000-00000000000e', true, 1, 'harden-probe-1');
RESET ROLE;

SELECT ok(
  (SELECT evaluator = 'd5822222-2222-4222-8222-222222222222' AND total_calls = 1
     FROM arena_entries WHERE gene_id = 'd58e0000-0000-4000-8000-00000000000e'),
  'P10: another user''s log_mcp_call counts the call but leaves the row''s evaluator alone');

SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$ SELECT log_mcp_call('harden_probe', 'd58f0000-0000-4000-8000-00000000000f', true, 1, 'harden-probe-2') $$,
  'P11a: logging a call for a gene with a binding_runtime row succeeds');
RESET ROLE;

SELECT ok(
  (SELECT total_calls = 1 AND evaluator = 'binding' AND evaluation_method = 'binding_runtime'
     FROM arena_entries WHERE gene_id = 'd58f0000-0000-4000-8000-00000000000f'),
  'P11b: ...and counts it without touching the measurement');

-- ── P12, P13: the invalidation job is the server's ──────────

SELECT ok(
  NOT has_function_privilege('anon', 'public.apply_arena_invalidation()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.apply_arena_invalidation()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.apply_arena_invalidation()', 'EXECUTE'),
  'P12: only service_role may run apply_arena_invalidation()');

-- Run it inside a transaction that carries a client JWT, as a DEFINER call
-- reached from a client request would. The Native fixtures have no artifact,
-- so the job invalidates them: it does touch rows.
SET LOCAL request.jwt.claims = '{"sub":"d5811111-1111-4111-8111-111111111111","role":"authenticated"}';
CREATE TEMP TABLE before_evaluators AS SELECT gene_id, evaluator FROM arena_entries
  WHERE gene_id::TEXT LIKE 'd58%';
SELECT lives_ok(
  $$ SELECT * FROM apply_arena_invalidation() $$,
  'P13a: the job runs to the end, binding_runtime row included');
SELECT ok(
  (SELECT bool_and(a.evaluator IS NOT DISTINCT FROM b.evaluator)
     FROM arena_entries a JOIN before_evaluators b USING (gene_id))
  AND (SELECT invalidation_reason = 'no-published-artifact' FROM arena_entries
        WHERE gene_id = 'd58b0000-0000-4000-8000-00000000000b'),
  'P13b: ...invalidating rows without stamping the JWT''s user as their evaluator');
SELECT ok(
  EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'apply-arena-invalidation' AND schedule = '30 1 * * *'),
  'P13c: the job is scheduled daily');
RESET request.jwt.claims;

-- ── P14–P16: evaluation runs ────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"d5822222-2222-4222-8222-222222222222","role":"authenticated"}';

SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('d58b0000-0000-4000-8000-00000000000b', 'd58aaaaa-0000-4000-8000-000000000001', 0, true, true, 1, 1) $$,
  '42501', NULL,
  'P14: a user cannot record runs for someone else''s gene');

SET LOCAL request.jwt.claims = '{"sub":"d5811111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('d58b0000-0000-4000-8000-00000000000b', 'd58aaaaa-0000-4000-8000-000000000002', 0, true, true, 1, 1) $$,
  'P15a: the owner records a run');

SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('d58c0000-0000-4000-8000-00000000000c', 'd58aaaaa-0000-4000-8000-000000000002', 1, true, true, 1, 1) $$,
  '42501', NULL,
  'P15b: a submission belongs to one gene, even across genes the same user owns');

RESET ROLE;

-- The guard alone: evaluated_at and the run_index cap are not covered by a
-- privilege the test role lacks.
SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost, evaluated_at)
     VALUES ('d58c0000-0000-4000-8000-00000000000c', 'd58aaaaa-0000-4000-8000-000000000003', 0, true, true, 1, 1, '2099-01-01') $$,
  'P16a: a client run with evaluated_at in 2099 is accepted...');
SELECT ok(
  (SELECT evaluated_at < now() + interval '1 minute' FROM arena_evaluation_runs
    WHERE submission_id = 'd58aaaaa-0000-4000-8000-000000000003'),
  'P16b: ...with the server''s time, not the client''s');
SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, output_schema_valid, latency_ms, resource_cost)
     VALUES ('d58c0000-0000-4000-8000-00000000000c', 'd58aaaaa-0000-4000-8000-000000000004', 100, true, true, 1, 1) $$,
  '42501', NULL,
  'P16c: run_index is capped per submission');

-- ── P18: what the current CLI does still works ──────────────

SET LOCAL ROLE authenticated;

-- arenaSubmit: POST /arena_entries?on_conflict=gene_id, merge-duplicates —
-- an upsert of the 14 columns it sends.
SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, safety_score, success_rate, latency_score,
                                resource_efficiency, evaluation_method, evaluation_n, base_fitness, fidelity_discount,
                                fitness_reference, l_ref_ms, cost_ref)
     VALUES ('d58c0000-0000-4000-8000-00000000000c', 'test.harden', 0.42, 0.9, 1, 0.5, 0.5, 'estimated', 3, 0.42, 1.0,
             'fallback', 1000, 10000)
     ON CONFLICT (gene_id) DO UPDATE SET
       domain = EXCLUDED.domain, fitness_value = EXCLUDED.fitness_value, safety_score = EXCLUDED.safety_score,
       success_rate = EXCLUDED.success_rate, latency_score = EXCLUDED.latency_score,
       resource_efficiency = EXCLUDED.resource_efficiency, evaluation_method = EXCLUDED.evaluation_method,
       evaluation_n = EXCLUDED.evaluation_n, base_fitness = EXCLUDED.base_fitness,
       fidelity_discount = EXCLUDED.fidelity_discount, fitness_reference = EXCLUDED.fitness_reference,
       l_ref_ms = EXCLUDED.l_ref_ms, cost_ref = EXCLUDED.cost_ref, gene_id = EXCLUDED.gene_id $$,
  'P18a: a first submission (CLI upsert, 14 columns) succeeds');

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, safety_score, success_rate, latency_score,
                                resource_efficiency, evaluation_method, evaluation_n, base_fitness, fidelity_discount,
                                fitness_reference, l_ref_ms, cost_ref)
     VALUES ('d58c0000-0000-4000-8000-00000000000c', 'test.harden', 0.55, 0.9, 1, 0.5, 0.5, 'estimated', 3, 0.55, 1.0,
             'fallback', 1000, 10000)
     ON CONFLICT (gene_id) DO UPDATE SET
       domain = EXCLUDED.domain, fitness_value = EXCLUDED.fitness_value, safety_score = EXCLUDED.safety_score,
       success_rate = EXCLUDED.success_rate, latency_score = EXCLUDED.latency_score,
       resource_efficiency = EXCLUDED.resource_efficiency, evaluation_method = EXCLUDED.evaluation_method,
       evaluation_n = EXCLUDED.evaluation_n, base_fitness = EXCLUDED.base_fitness,
       fidelity_discount = EXCLUDED.fidelity_discount, fitness_reference = EXCLUDED.fitness_reference,
       l_ref_ms = EXCLUDED.l_ref_ms, cost_ref = EXCLUDED.cost_ref, gene_id = EXCLUDED.gene_id $$,
  'P18b: a re-submission of the same gene (conflict → update) succeeds');

SELECT lives_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, output_schema_valid,
                                        latency_ms, resource_cost, failure_kind)
     VALUES ('d58c0000-0000-4000-8000-00000000000c', 'd58aaaaa-0000-4000-8000-000000000005', 0, true, true, 1, 1, NULL),
            ('d58c0000-0000-4000-8000-00000000000c', 'd58aaaaa-0000-4000-8000-000000000005', 1, true, NULL, 2, 2, NULL),
            ('d58c0000-0000-4000-8000-00000000000c', 'd58aaaaa-0000-4000-8000-000000000005', 2, false, NULL, 3, 3, 'crash') $$,
  'P18c: publishEvaluationRuns (8 columns, one POST of 3 runs) succeeds');

RESET ROLE;

SELECT ok(
  (SELECT fitness_value = 0.55 AND total_calls = 0 AND evaluator = 'd5811111-1111-4111-8111-111111111111'
     FROM arena_entries WHERE gene_id = 'd58c0000-0000-4000-8000-00000000000c'),
  'P18d: the re-submission''s values landed, with the server-owned columns set by the server');

SELECT * FROM finish();
ROLLBACK;
