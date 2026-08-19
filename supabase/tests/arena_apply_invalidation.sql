-- ============================================================
-- pgTAP tests for the 2.5 write layer (ADR-319 D2)
-- File: supabase/tests/arena_apply_invalidation.sql
-- ============================================================
--
-- Migration 20260819170000. The criteria have been readable since #214; this
-- is the half that writes them down.
--
-- T7-T9 carry the weight. The job must clear an invalidation it previously set
-- once the criteria stop firing — that is what makes a criteria change safe to
-- deploy, and #220 already proved the case is real (narrowing
-- no-published-artifact to Native released nine Hybrid rows). And it must
-- never clear an invalidation carrying a reason it does not own: a removal
-- this job did not make is not one it may undo. A self-correcting job without
-- that second half would quietly launder a hand edit into a criteria decision,
-- which is the inverse of what ADR-319 D6 asks for.
--
-- T10 pins that nothing is deleted and no score moves. The whole design rests
-- on a disqualified row keeping its numbers.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(12);

-- ------------------------------------------------------------
-- Fixture: one author, five genes covering each verdict.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('b8111111-1111-4111-8111-111111111111', 'inval-test@example.com',
        '{"user_name": "inval_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash, wasm_path, wasm_size)
VALUES
  -- clean Native with an artifact
  ('b8222222-2222-4222-8222-222222222222', 'b8111111-1111-4111-8111-111111111111',
   'inval-clean', 'test.inval', '0.1.0', 'Native',
   '{"domain":"test.inval","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('4', 64), 'o/inval-clean/0.1.0/g.wasm', 1000),
  -- Native with no artifact
  ('b8333333-3333-4333-8333-333333333333', 'b8111111-1111-4111-8111-111111111111',
   'inval-noartifact', 'test.inval', '0.1.0', 'Native',
   '{"domain":"test.inval","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('5', 64), NULL, 0),
  -- Hybrid with no artifact — legitimate under the shipping design
  ('b8444444-4444-4444-8444-444444444444', 'b8111111-1111-4111-8111-111111111111',
   'inval-hybrid', 'test.inval', '0.1.0', 'Hybrid',
   '{"domain":"test.inval","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('6', 64), NULL, 0),
  -- Native with an artifact that carries the marker
  ('b8555555-5555-4555-8555-555555555555', 'b8111111-1111-4111-8111-111111111111',
   'inval-defective', 'test.inval', '0.1.0', 'Native',
   '{"domain":"test.inval","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('7', 64), 'o/inval-defective/0.1.0/g.wasm', 2000),
  -- clean gene used for the test-domain row
  ('b8666666-6666-4666-8666-666666666666', 'b8111111-1111-4111-8111-111111111111',
   'inval-testdomain', 'test.inval', '0.1.0', 'Wrapped',
   '{"domain":"test.inval","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('8', 64), NULL, 0);

INSERT INTO gene_artifact_scan (gene_id, wasm_sha256, marker, occurrences)
VALUES ('b8555555-5555-4555-8555-555555555555', repeat('a', 64), 'async function express', 3);

INSERT INTO arena_entries (gene_id, domain, fitness_value, safety_score, evaluation_method) VALUES
  ('b8222222-2222-4222-8222-222222222222', 'test.inval', 0.8, 0.9, 'sandbox'),
  ('b8333333-3333-4333-8333-333333333333', 'test.inval', 0.7, 0.9, 'estimated'),
  ('b8444444-4444-4444-8444-444444444444', 'test.inval', 0.6, 0.9, 'estimated'),
  ('b8555555-5555-4555-8555-555555555555', 'test.inval', 1.0, 1.0, 'sandbox'),
  ('b8666666-6666-4666-8666-666666666666', 'test',       0.5, 1.0, 'declared');

-- T1-T5: the verdict per row, before anything is written
SELECT is(arena_invalidation_verdict('b8222222-2222-4222-8222-222222222222'), NULL, 'T1: a Native gene with an artifact is clean');
SELECT is(arena_invalidation_verdict('b8333333-3333-4333-8333-333333333333'), 'no-published-artifact', 'T2: Native with no artifact');
SELECT is(arena_invalidation_verdict('b8444444-4444-4444-8444-444444444444'), NULL, 'T3: Hybrid with no artifact is NOT disqualified — the shipping Hybrid path publishes none');
SELECT is(arena_invalidation_verdict('b8555555-5555-4555-8555-555555555555'), 'async-express-artifact', 'T4: a scanned marker disqualifies the row');
SELECT is(arena_invalidation_verdict('b8666666-6666-4666-8666-666666666666'), 'test-data', 'T5: the test domain wins over everything else');

-- T6: applying writes exactly the three
SELECT lives_ok('SELECT apply_arena_invalidation()', 'T6: the job runs');

SELECT is(
  (SELECT count(*)::INT FROM arena_entries
    WHERE gene_id IN ('b8222222-2222-4222-8222-222222222222','b8333333-3333-4333-8333-333333333333',
                      'b8444444-4444-4444-8444-444444444444','b8555555-5555-4555-8555-555555555555',
                      'b8666666-6666-4666-8666-666666666666')
      AND invalidated_at IS NOT NULL),
  3, 'T7: three of five rows are disqualified, the clean and Hybrid rows are not');

-- T8: idempotent — a second run changes nothing
SELECT is(
  (SELECT invalidated FROM apply_arena_invalidation()),
  0, 'T8: a second run invalidates nothing new');

-- T9: self-correcting — publish the missing artifact and the row is released
UPDATE genes SET wasm_size = 1234, wasm_path = 'o/inval-noartifact/0.1.0/g.wasm'
 WHERE id = 'b8333333-3333-4333-8333-333333333333';
SELECT is((SELECT released FROM apply_arena_invalidation()), 1,
  'T9: the job clears its own invalidation once the criterion stops firing');
SELECT is(
  (SELECT invalidation_reason FROM arena_entries WHERE gene_id = 'b8333333-3333-4333-8333-333333333333'),
  NULL, 'T10: the released row carries no stale reason');

-- T11: a reason this job does not own is never cleared
UPDATE arena_entries SET invalidated_at = now(), invalidation_reason = 'someone-said-so'
 WHERE gene_id = 'b8222222-2222-4222-8222-222222222222';
SELECT * FROM apply_arena_invalidation();
SELECT is(
  (SELECT invalidation_reason FROM arena_entries WHERE gene_id = 'b8222222-2222-4222-8222-222222222222'),
  'someone-said-so', 'T11: an invalidation this job did not set is not undone by it');

-- T12: nothing is deleted and no score moves
SELECT is(
  (SELECT count(*)::INT FROM arena_entries WHERE gene_id = 'b8555555-5555-4555-8555-555555555555' AND fitness_value = 1.0),
  1, 'T12: a disqualified row keeps its row and its numbers');

SELECT * FROM finish();
ROLLBACK;
