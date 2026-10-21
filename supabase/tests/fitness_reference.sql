-- ============================================================
-- pgTAP tests for get_fitness_reference + arena_entries reference columns
-- File: supabase/tests/fitness_reference.sql
-- ============================================================
--
-- Migration 20261021120000 (ADR-318 D2, v0.9.3 #6). The function computes
-- F(g)'s L_ref / Cost_ref as current-season medians. One fixture exercises
-- every population rule at once: three Genes owned and measured by their owner
-- give medians of 20 ms / 200 fuel, and each excluded case below would move
-- those medians if it were counted —
--   * an older submission of g1 (100 ms)         — only the latest counts
--   * a failed run inside g2's submission (999)  — averages use successes only
--   * runs on g3 recorded by someone else (1 ms) — owner runs only
--   * an unpublished Gene (5 ms)                 — published only
--   * an invalidated Gene (6 ms)                 — invalidated entries excluded
--   * a Wrapped Gene in the same domain (7 ms)   — same fidelity only
--   * a Gene whose latest submission failed (8)  — needs a successful run
--   * a run from before the season began (9 ms)  — current season only
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(16);

-- ── Fixture ─────────────────────────────────────────────────

-- In a freshly replayed database the active season began moments ago; move
-- its start back so the runs below fall inside it.
UPDATE seasons SET started_at = now() - interval '1 day' WHERE status = 'active';

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f1111111-1111-4111-8111-111111111111', 'fref-owner@example.com', '{"user_name": "fref_owner"}'::jsonb),
  ('f1111111-1111-4111-8111-222222222222', 'fref-other@example.com', '{"user_name": "fref_other"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'f1111111-1111-4111-8111-111111111111', 'fref-g1', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, true,  repeat('1', 64)),
  ('f2000000-0000-4000-8000-000000000002', 'f1111111-1111-4111-8111-111111111111', 'fref-g2', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, true,  repeat('2', 64)),
  ('f2000000-0000-4000-8000-000000000003', 'f1111111-1111-4111-8111-111111111111', 'fref-g3', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, true,  repeat('3', 64)),
  ('f2000000-0000-4000-8000-000000000004', 'f1111111-1111-4111-8111-111111111111', 'fref-g4', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, false, repeat('4', 64)),
  ('f2000000-0000-4000-8000-000000000005', 'f1111111-1111-4111-8111-111111111111', 'fref-g5', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, true,  repeat('5', 64)),
  ('f2000000-0000-4000-8000-000000000006', 'f1111111-1111-4111-8111-111111111111', 'fref-g6', 'test.fref', '0.1.0', 'Wrapped','{}'::jsonb, true,  repeat('6', 64)),
  ('f2000000-0000-4000-8000-000000000007', 'f1111111-1111-4111-8111-111111111111', 'fref-g7', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, true,  repeat('7', 64)),
  ('f2000000-0000-4000-8000-000000000008', 'f1111111-1111-4111-8111-111111111111', 'fref-g8', 'test.fref', '0.1.0', 'Native', '{}'::jsonb, true,  repeat('9', 64));

-- g5's Arena entry is invalidated.
INSERT INTO arena_entries (gene_id, domain, invalidated_at, invalidation_reason)
VALUES ('f2000000-0000-4000-8000-000000000005', 'test.fref', now(), 'async-express-artifact');

-- evaluator is written explicitly: the stamping trigger only fills it for an
-- authenticated principal, and this runs as the test superuser.
INSERT INTO arena_evaluation_runs
  (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost, evaluator, evaluated_at)
VALUES
  -- g1: an older submission (100 ms) superseded by a newer one (10 ms)
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000011', 0, true, 100, 1000, 'f1111111-1111-4111-8111-111111111111', now() - interval '2 minutes'),
  ('f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000012', 0, true,  10,  100, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute'),
  -- g2: one success at 20 ms and one failure that must not enter the average
  ('f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000021', 0, true,   20,  200, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute'),
  ('f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000021', 1, false, 999, 9999, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute'),
  -- g3: the owner measured 40 ms; a later submission by someone else says 1 ms
  ('f2000000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000031', 0, true, 40, 400, 'f1111111-1111-4111-8111-111111111111', now() - interval '2 minutes'),
  ('f2000000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000032', 0, true,  1,   1, 'f1111111-1111-4111-8111-222222222222', now() - interval '1 minute'),
  -- g4 unpublished, g5 invalidated, g6 Wrapped
  ('f2000000-0000-4000-8000-000000000004', 'f3000000-0000-4000-8000-000000000041', 0, true, 5, 50, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute'),
  ('f2000000-0000-4000-8000-000000000005', 'f3000000-0000-4000-8000-000000000051', 0, true, 6, 60, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute'),
  ('f2000000-0000-4000-8000-000000000006', 'f3000000-0000-4000-8000-000000000061', 0, true, 7, 70, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute'),
  -- g7: an earlier success, then a latest submission where nothing succeeded
  ('f2000000-0000-4000-8000-000000000007', 'f3000000-0000-4000-8000-000000000071', 0, true,  8, 80, 'f1111111-1111-4111-8111-111111111111', now() - interval '2 minutes'),
  ('f2000000-0000-4000-8000-000000000007', 'f3000000-0000-4000-8000-000000000072', 0, false, 0,  0, 'f1111111-1111-4111-8111-111111111111', now() - interval '1 minute');

-- g8: measured before the active season started
INSERT INTO arena_evaluation_runs
  (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost, evaluator, evaluated_at)
SELECT 'f2000000-0000-4000-8000-000000000008', 'f3000000-0000-4000-8000-000000000081', 0, true, 9, 90,
       'f1111111-1111-4111-8111-111111111111', s.started_at - interval '1 day'
FROM seasons s WHERE s.status = 'active' ORDER BY s.season_number DESC LIMIT 1;

-- ── Shape and security attributes ───────────────────────────

SELECT has_function('public', 'get_fitness_reference', ARRAY['text', 'text'],
  'T1: get_fitness_reference(text, text) exists');

SELECT is(
  (SELECT pg_get_function_result('get_fitness_reference(text,text)'::regprocedure)),
  'TABLE(l_ref_ms double precision, cost_ref double precision, sample_genes integer, season_number integer)',
  'T2: it returns exactly the four reference fields, nothing about any person');

SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'get_fitness_reference(text,text)'::regprocedure),
  false,
  'T3: SECURITY INVOKER — it reads with the caller''s rights, never more');

SELECT is(
  (SELECT provolatile::TEXT FROM pg_proc WHERE oid = 'get_fitness_reference(text,text)'::regprocedure),
  's',
  'T4: STABLE — read-only; a STABLE SQL function cannot modify data');

SELECT ok(
  (SELECT 'search_path=public, pg_temp' = ANY (proconfig) FROM pg_proc WHERE oid = 'get_fitness_reference(text,text)'::regprocedure),
  'T5: search_path is pinned to public, pg_temp');

SELECT ok(
  has_function_privilege('anon', 'get_fitness_reference(text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'get_fitness_reference(text,text)', 'EXECUTE'),
  'T6: anon and authenticated may call it');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid = 'get_fitness_reference(text,text)'::regprocedure AND a.grantee = 0
  ),
  'T7: no EXECUTE for PUBLIC — the grants are explicit');

-- ── The medians ─────────────────────────────────────────────

UPDATE seasons SET config = config || '{"fitness_reference_min_genes": 3}'::jsonb WHERE status = 'active';

SELECT results_eq(
  $$ SELECT l_ref_ms, cost_ref, sample_genes FROM get_fitness_reference('test.fref', 'Native') $$,
  $$ VALUES (20::DOUBLE PRECISION, 200::DOUBLE PRECISION, 3) $$,
  'T8: medians over g1–g3 only — latest submission, successes, owner runs, published, valid, same fidelity, this season');

SELECT is(
  (SELECT season_number FROM get_fitness_reference('test.fref', 'Native')),
  (SELECT season_number FROM seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1),
  'T9: it reports which season the medians belong to');

SELECT is_empty(
  $$ SELECT * FROM get_fitness_reference('test.fref', 'Hybrid') $$,
  'T10: a group with no measurements gives no row');

UPDATE seasons SET config = config || '{"fitness_reference_min_genes": 4}'::jsonb WHERE status = 'active';
SELECT is_empty(
  $$ SELECT * FROM get_fitness_reference('test.fref', 'Native') $$,
  'T11: three Genes under a minimum of four give no row — the CLI falls back');

UPDATE seasons SET config = config - 'fitness_reference_min_genes' WHERE status = 'active';
SELECT is_empty(
  $$ SELECT * FROM get_fitness_reference('test.fref', 'Native') $$,
  'T12: without a season setting the minimum is 5');

-- anon gets the same answer: everything it reads is public, and unpublished
-- Genes are excluded by the query itself, not by whoever happens to call.
UPDATE seasons SET config = config || '{"fitness_reference_min_genes": 3}'::jsonb WHERE status = 'active';
SET LOCAL ROLE anon;
SELECT results_eq(
  $$ SELECT l_ref_ms, cost_ref, sample_genes FROM get_fitness_reference('test.fref', 'Native') $$,
  $$ VALUES (20::DOUBLE PRECISION, 200::DOUBLE PRECISION, 3) $$,
  'T13: anon can call it and gets the same medians');
RESET ROLE;

-- ── Arena rows record the reference they were scaled by ─────

SELECT has_column('public', 'arena_entries', 'fitness_reference', 'T14: arena_entries.fitness_reference exists');

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_reference)
     VALUES ('f2000000-0000-4000-8000-000000000001', 'test.fref', 'season-median') $$,
  '23514',
  NULL,
  'T15: a reference source without its two values is rejected (NULL > 0 must not slip through)');

SELECT lives_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, l_ref_ms, cost_ref, fitness_reference)
     VALUES ('f2000000-0000-4000-8000-000000000002', 'test.fref', 20, 200, 'season-median') $$,
  'T16: a row with its reference recorded is accepted');

SELECT * FROM finish();
ROLLBACK;
