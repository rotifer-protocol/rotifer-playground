-- ============================================================
-- pgTAP tests for the gene delete guard (migration 20261021220000)
-- File: supabase/tests/gene_delete_guard.sql
-- ============================================================
--
-- Deleting a gene cascades to its Arena row and evaluation runs, so a client
-- may not delete a gene that is published or carries that evidence (T-64,
-- audit F3). A never-published, never-evaluated draft stays deletable;
-- service_role and unpublish_gene() are unaffected.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(9);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f6411111-1111-4111-8111-111111111111', 'delete-guard@example.com', '{"user_name": "delete_guard"}'::jsonb);

-- pub: published, no Arena row. arena: unpublished, has an Arena row.
-- runs: unpublished, has evaluation runs. draft: neither. svc: published,
-- with an Arena row (deleted by service_role). unpub: published, taken down
-- with unpublish_gene().
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f64a0000-0000-4000-8000-00000000000a', 'f6411111-1111-4111-8111-111111111111', 'del-pub',   'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('1', 64)),
  ('f64b0000-0000-4000-8000-00000000000b', 'f6411111-1111-4111-8111-111111111111', 'del-arena', 'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('2', 64)),
  ('f64c0000-0000-4000-8000-00000000000c', 'f6411111-1111-4111-8111-111111111111', 'del-runs',  'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('3', 64)),
  ('f64d0000-0000-4000-8000-00000000000d', 'f6411111-1111-4111-8111-111111111111', 'del-draft', 'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('4', 64)),
  ('f64e0000-0000-4000-8000-00000000000e', 'f6411111-1111-4111-8111-111111111111', 'del-svc',   'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('5', 64)),
  ('f64f0000-0000-4000-8000-00000000000f', 'f6411111-1111-4111-8111-111111111111', 'del-unpub', 'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('6', 64)),
  ('f6400000-0000-4000-8000-000000000010', 'f6411111-1111-4111-8111-111111111111', 'del-history', 'test.delete', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('7', 64));

INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method) VALUES
  ('f64b0000-0000-4000-8000-00000000000b', 'test.delete', 0.4, 'estimated'),
  ('f64e0000-0000-4000-8000-00000000000e', 'test.delete', 0.4, 'estimated');
INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost)
VALUES ('f64c0000-0000-4000-8000-00000000000c', 'f64ccccc-0000-4000-8000-000000000001', 0, true, 1, 1);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f6411111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT throws_ok(
  $$ DELETE FROM genes WHERE id = 'f64a0000-0000-4000-8000-00000000000a' $$,
  '42501', NULL,
  'T1: the owner cannot delete a published gene');

SELECT throws_ok(
  $$ DELETE FROM genes WHERE id = 'f64b0000-0000-4000-8000-00000000000b' $$,
  '42501', NULL,
  'T2: nor an unpublished gene with an Arena record');

SELECT throws_ok(
  $$ DELETE FROM genes WHERE id = 'f64c0000-0000-4000-8000-00000000000c' $$,
  '42501', NULL,
  'T3: nor one with evaluation runs');

SELECT lives_ok(
  $$ DELETE FROM genes WHERE id = 'f64d0000-0000-4000-8000-00000000000d' $$,
  'T4: a draft that was never published or evaluated can still be deleted');

-- Taking a version down is unpublish_gene(), an UPDATE: not affected.
SELECT lives_ok(
  $$ SELECT * FROM unpublish_gene('f64f0000-0000-4000-8000-00000000000f', 'superseded') $$,
  'T5: unpublish_gene() still takes a published version down');

-- T-64 acceptance: published, invoked, taken down, then deleted. No Arena
-- row, and it is unpublished by the time of the delete — but it was public,
-- and its invocation and its take-down are on record.
SELECT log_gene_invocation('f6400000-0000-4000-8000-000000000010', 'f6411111-1111-4111-8111-111111111111');
SELECT * FROM unpublish_gene('f6400000-0000-4000-8000-000000000010', 'about to delete');
SELECT throws_ok(
  $$ DELETE FROM genes WHERE id = 'f6400000-0000-4000-8000-000000000010' $$,
  '42501', NULL,
  'T9: a gene that was published, invoked and taken down cannot be deleted — its history is the evidence, not its current state');

RESET ROLE;

SELECT ok(
  EXISTS (SELECT 1 FROM arena_entries WHERE gene_id = 'f64b0000-0000-4000-8000-00000000000b')
  AND EXISTS (SELECT 1 FROM arena_evaluation_runs WHERE gene_id = 'f64c0000-0000-4000-8000-00000000000c')
  AND NOT EXISTS (SELECT 1 FROM genes WHERE id = 'f64d0000-0000-4000-8000-00000000000d')
  AND (SELECT NOT published FROM genes WHERE id = 'f64f0000-0000-4000-8000-00000000000f'),
  'T6: the evidence is still there, the draft is gone, the unpublished version is down');

-- service_role is not a client.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT lives_ok(
  $$ DELETE FROM genes WHERE id = 'f64e0000-0000-4000-8000-00000000000e' $$,
  'T7: service_role can delete a published gene with an Arena record');
RESET request.jwt.claims;

SELECT ok(
  NOT EXISTS (SELECT 1 FROM genes WHERE id = 'f64e0000-0000-4000-8000-00000000000e')
  AND NOT EXISTS (SELECT 1 FROM arena_entries WHERE gene_id = 'f64e0000-0000-4000-8000-00000000000e'),
  'T8: ...and the cascade runs as before');

SELECT * FROM finish();
ROLLBACK;
