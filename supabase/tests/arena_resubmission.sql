-- ============================================================
-- pgTAP tests for an Arena re-submission (migration 20261021180000)
-- File: supabase/tests/arena_resubmission.sql
-- ============================================================
--
-- A second `arena submit` of a gene is an UPDATE of its arena_entries row
-- (since #431). It must move last_evaluated — the date the site shows next to
-- the score — and recompute the gene's reputation, both of which used to
-- happen on INSERT only. Server-side updates (season reset, invalidation,
-- call counting) must not move last_evaluated.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(13);

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('c5111111-1111-4111-8111-111111111111', 'resubmit@example.com', '{"user_name": "resubmit_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('c5222222-2222-4222-8222-222222222222', 'c5111111-1111-4111-8111-111111111111',
   'resubmit-gene', 'test.resubmit', '0.1.0', 'Native', '{}'::jsonb, true, repeat('c', 64)),
  ('c5333333-3333-4333-8333-333333333333', 'c5111111-1111-4111-8111-111111111111',
   'resubmit-gene-2', 'test.resubmit', '0.1.0', 'Native', '{}'::jsonb, true, repeat('d', 64));

-- The first submission, a day ago, measured: it counts toward reputation.
INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, last_evaluated)
VALUES ('c5222222-2222-4222-8222-222222222222', 'test.resubmit', 0.2, 'sandbox', now() - interval '1 day');

SELECT is(
  (SELECT arena_score FROM gene_reputation WHERE gene_id = 'c5222222-2222-4222-8222-222222222222' ORDER BY epoch DESC LIMIT 1),
  0.2::DOUBLE PRECISION,
  'T1: the first submission set reputation (INSERT trigger, unchanged)');

-- ── Server-side updates do not move last_evaluated ──────────

UPDATE arena_entries SET fitness_value = fitness_value * 0.5
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';
SELECT ok(
  (SELECT last_evaluated < now() - interval '23 hours' FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  'T2: a server-side fitness change (as reset_season makes) leaves last_evaluated alone');

SELECT is(
  (SELECT arena_score FROM gene_reputation WHERE gene_id = 'c5222222-2222-4222-8222-222222222222' ORDER BY epoch DESC LIMIT 1),
  0.1::DOUBLE PRECISION,
  'T3: ...but reputation follows the new fitness');

UPDATE arena_entries SET invalidated_at = now(), invalidation_reason = 'test-data'
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';
UPDATE arena_entries SET invalidated_at = NULL, invalidation_reason = NULL
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';
SELECT ok(
  (SELECT last_evaluated < now() - interval '23 hours' FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  'T4: invalidating and restoring the row leaves last_evaluated alone');

-- ── A client re-submission (PostgREST shape) ────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"c5111111-1111-4111-8111-111111111111","role":"authenticated"}';

UPDATE arena_entries SET domain = domain
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';

RESET ROLE;
SELECT ok(
  (SELECT last_evaluated < now() - interval '23 hours' FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  'T5: a client update of a column a submission does not write leaves last_evaluated alone');
-- What PostgREST runs for `POST /arena_entries?on_conflict=gene_id` with
-- merge-duplicates: an upsert that sets every submitted column. Including
-- last_evaluated, backdated, to show the client cannot choose it. Since
-- 20261021200000 PostgREST cannot even send last_evaluated (no column
-- privilege), so this runs as the test role with the client's claims: the
-- guard is checked on its own.
INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, evaluation_n, last_evaluated)
VALUES ('c5222222-2222-4222-8222-222222222222', 'test.resubmit', 0.9, 'sandbox', 3, now() - interval '30 days')
ON CONFLICT (gene_id) DO UPDATE
  SET fitness_value = EXCLUDED.fitness_value,
      evaluation_method = EXCLUDED.evaluation_method,
      evaluation_n = EXCLUDED.evaluation_n,
      last_evaluated = EXCLUDED.last_evaluated;

RESET ROLE;
RESET request.jwt.claims;

SELECT is(
  (SELECT last_evaluated FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  now(),
  'T6: the re-submission moves last_evaluated to the server''s now(), whatever the client sent');

SELECT is(
  (SELECT fitness_value FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  0.9::DOUBLE PRECISION,
  'T7: the re-submitted score is the one stored');

SELECT is(
  (SELECT arena_score FROM gene_reputation WHERE gene_id = 'c5222222-2222-4222-8222-222222222222' ORDER BY epoch DESC LIMIT 1),
  0::DOUBLE PRECISION,
  'T8: the re-submission recomputed reputation (from 0.1): a client re-submission is recorded as estimated since 20261021200000 (T-58 F4), and an estimate carries no arena score');

-- Re-submitting the same score is still an evaluation for the date, but
-- reputation has nothing new to compute.
CREATE TEMP TABLE rep_before AS
  SELECT count(*)::INTEGER AS n FROM gene_reputation WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';
UPDATE arena_entries SET last_evaluated = now() - interval '1 day'
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"c5111111-1111-4111-8111-111111111111","role":"authenticated"}';
INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, evaluation_n)
VALUES ('c5222222-2222-4222-8222-222222222222', 'test.resubmit', 0.9, 'sandbox', 3)
ON CONFLICT (gene_id) DO UPDATE
  SET fitness_value = EXCLUDED.fitness_value,
      evaluation_method = EXCLUDED.evaluation_method,
      evaluation_n = EXCLUDED.evaluation_n;
RESET ROLE;
RESET request.jwt.claims;

SELECT is(
  (SELECT last_evaluated FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  now(),
  'T9: re-submitting the same score still moves last_evaluated — it was evaluated again');

SELECT is(
  (SELECT count(*)::INTEGER FROM gene_reputation WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  (SELECT n FROM rep_before),
  'T10: ...but reputation is not recomputed when no score column changed');

-- ── A client cannot choose last_evaluated (T-56 acceptance) ──

UPDATE arena_entries SET last_evaluated = now() - interval '1 day'
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';

-- As above: the guard on its own (the column privilege also refuses it).
SET LOCAL request.jwt.claims = '{"sub":"c5111111-1111-4111-8111-111111111111","role":"authenticated"}';
UPDATE arena_entries SET last_evaluated = '2099-01-01T00:00:00Z'
 WHERE gene_id = 'c5222222-2222-4222-8222-222222222222';
INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method, last_evaluated)
VALUES ('c5333333-3333-4333-8333-333333333333', 'test.resubmit', 0.4, 'sandbox', '2099-01-01T00:00:00Z');
RESET ROLE;
RESET request.jwt.claims;

SELECT ok(
  (SELECT last_evaluated < now() - interval '23 hours' FROM arena_entries WHERE gene_id = 'c5222222-2222-4222-8222-222222222222'),
  'T11: a client PATCH of last_evaluated alone (2099) is ignored — the previous value stays');

SELECT is(
  (SELECT last_evaluated FROM arena_entries WHERE gene_id = 'c5333333-3333-4333-8333-333333333333'),
  now(),
  'T12: a client INSERT that sends last_evaluated (2099) gets the server''s now()');

-- The server itself may still set it (a future server-side evaluator).
UPDATE arena_entries SET last_evaluated = '2030-01-01T00:00:00Z'
 WHERE gene_id = 'c5333333-3333-4333-8333-333333333333';
SELECT is(
  (SELECT last_evaluated FROM arena_entries WHERE gene_id = 'c5333333-3333-4333-8333-333333333333'),
  '2030-01-01T00:00:00Z'::TIMESTAMPTZ,
  'T13: a server-side write sets last_evaluated as given');

SELECT * FROM finish();
ROLLBACK;
