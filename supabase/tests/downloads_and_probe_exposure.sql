-- ============================================================
-- pgTAP tests for migration 20261022120000 (T-67a)
-- File: supabase/tests/downloads_and_probe_exposure.sql
-- ============================================================
--
-- #7: no client reads download rows (who downloaded, when); the aggregate
--     get_gene_stats() still answers and track_download() still records.
-- #8: the duplicate probe exposes gene_id and after_guard only; the
--     rotifer-admin probe's queries run unchanged.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f6a11111-1111-4111-8111-111111111111', 'exposure-author@example.com', '{"user_name": "exposure_author"}'::jsonb),
  ('f6a22222-2222-4222-8222-222222222222', 'exposure-reader@example.com', '{"user_name": "exposure_reader"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f6aa0000-0000-4000-8000-00000000000a', 'f6a11111-1111-4111-8111-111111111111', 'exposure-gene', 'test.exposure', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('a', 64));

-- The reader downloaded the author's gene.
INSERT INTO downloads (gene_id, user_id) VALUES
  ('f6aa0000-0000-4000-8000-00000000000a', 'f6a22222-2222-4222-8222-222222222222');

-- One duplicate pair after the guard: the same caller, one second apart.
INSERT INTO gene_invocation_log (gene_id, caller_agent_id, gene_author_id, invoked_at) VALUES
  ('f6aa0000-0000-4000-8000-00000000000a', 'f6a22222-2222-4222-8222-222222222222', 'f6a11111-1111-4111-8111-111111111111', now() - interval '1 second'),
  ('f6aa0000-0000-4000-8000-00000000000a', 'f6a22222-2222-4222-8222-222222222222', 'f6a11111-1111-4111-8111-111111111111', now());

-- ── #7 downloads ───────────────────────────────────────────
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT throws_ok(
  $$ SELECT count(*) FROM downloads $$,
  '42501', NULL,
  'T1: anon cannot read download rows');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f6a11111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT throws_ok(
  $$ SELECT user_id, created_at FROM downloads WHERE gene_id = 'f6aa0000-0000-4000-8000-00000000000a' $$,
  '42501', NULL,
  'T2: nor can the gene''s author see who downloaded it and when');

SELECT is(
  (SELECT get_gene_stats('f6aa0000-0000-4000-8000-00000000000a') ->> 'last_7d'),
  '1',
  'T3: the author still gets the download count from get_gene_stats()');

SET LOCAL request.jwt.claims = '{"sub":"f6a22222-2222-4222-8222-222222222222","role":"authenticated"}';
SELECT lives_ok(
  $$ SELECT track_download('f6aa0000-0000-4000-8000-00000000000a'::uuid, 'cli') $$,
  'T4: track_download() still records a download');

-- ── #8 duplicate probe ─────────────────────────────────────
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';

-- rotifer-admin src/lib/invocation-pipeline-probe.ts, as PostgREST runs
-- `gene_invocation_duplicate_probe?select=gene_id&after_guard=is.true` with
-- Prefer: count=exact.
SELECT lives_ok(
  $$ SELECT count(*) FROM (SELECT gene_id FROM gene_invocation_duplicate_probe WHERE after_guard IS TRUE) t $$,
  'T5: the admin probe''s after_guard=is.true count runs as anon');

SELECT lives_ok(
  $$ SELECT count(*) FROM (SELECT gene_id FROM gene_invocation_duplicate_probe WHERE after_guard IS FALSE) t $$,
  'T6: and its after_guard=is.false count');

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE after_guard IS TRUE AND gene_id = 'f6aa0000-0000-4000-8000-00000000000a')::text,
  '1',
  'T7: and it still counts the duplicate pair');

SELECT throws_ok(
  $$ SELECT caller_agent_id FROM gene_invocation_duplicate_probe $$,
  '42501', NULL,
  'T8: the caller is not readable');

SELECT throws_ok(
  $$ SELECT invoked_at FROM gene_invocation_duplicate_probe $$,
  '42501', NULL,
  'T9: nor the time of the second call');

SELECT throws_ok(
  $$ SELECT previous_invoked_at FROM gene_invocation_duplicate_probe $$,
  '42501', NULL,
  'T10: nor the time of the first');

SELECT throws_ok(
  $$ SELECT gap FROM gene_invocation_duplicate_probe $$,
  '42501', NULL,
  'T11: nor the gap between them');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f6a11111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT throws_ok(
  $$ SELECT * FROM gene_invocation_duplicate_probe $$,
  '42501', NULL,
  'T12: a signed-in user cannot read the whole view either');
RESET ROLE;
RESET request.jwt.claims;

-- The reason the view runs as its owner: T-67 will narrow what clients may
-- read on the base table. Simulate that here (rolled back with the test).
REVOKE SELECT ON gene_invocation_log FROM anon;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT lives_ok(
  $$ SELECT count(*) FROM (SELECT gene_id FROM gene_invocation_duplicate_probe WHERE after_guard IS TRUE) t $$,
  'T13: the admin probe keeps working when anon can no longer read the base table');
RESET ROLE;
RESET request.jwt.claims;

SELECT ok(
  (SELECT 'security_invoker=false' = ANY (reloptions) FROM pg_class
    WHERE oid = 'public.gene_invocation_duplicate_probe'::regclass),
  'T14: because the view runs as its owner');

SELECT * FROM finish();
ROLLBACK;
