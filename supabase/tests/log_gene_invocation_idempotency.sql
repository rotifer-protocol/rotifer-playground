-- ============================================================
-- pgTAP tests for log_gene_invocation() idempotency (ADR-322 D1)
-- File: supabase/tests/log_gene_invocation_idempotency.sql
-- ============================================================
--
-- Regression for migration 20260818100000. A single MCP `run_gene` produced
-- two rows: the MCP server reports, and so does the CLI it shells out to
-- (playground >= 0.12.0). T2/T3 are the pair that used to fail — the second
-- report inserted instead of collapsing.
--
-- The window is deliberately narrow: it must swallow a duplicate arriving
-- milliseconds later, and must NOT swallow a genuine repeat call. T6 pins the
-- second half, which is the one that would silently lose real usage data if
-- the window were ever widened carelessly.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(9);

-- ------------------------------------------------------------
-- Fixture: one author (profile auto-created by handle_new_user), one
-- published gene. Rolled back at the end.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('c1111111-1111-4111-8111-111111111111', 'idem-test@example.com',
        '{"user_name": "idem_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('c2222222-2222-4222-8222-222222222222',
        'c1111111-1111-4111-8111-111111111111',
        'idem-test-gene', 'test.idem', '0.1.0', 'Wrapped',
        '{"domain":"test.idem","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('c', 64)),
       ('c3333333-3333-4333-8333-333333333333',
        'c1111111-1111-4111-8111-111111111111',
        'idem-test-other', 'test.idem', '0.1.0', 'Wrapped',
        '{"domain":"test.idem","inputSchema":{},"outputSchema":{},"version":"0.2.0"}'::jsonb,
        true, repeat('d', 64));

-- T1 — the function is still there with the same signature
SELECT has_function('public', 'log_gene_invocation', ARRAY['uuid', 'text'],
  'T1: log_gene_invocation(uuid, text) exists');

-- T2 — first report inserts
SELECT lives_ok(
  $$ SELECT log_gene_invocation('c2222222-2222-4222-8222-222222222222', 'idem-caller-x') $$,
  'T2: the first report is accepted');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'c2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'idem-caller-x'),
  1::bigint,
  'T2b: one row after the first report');

-- T3 — the duplicate that used to be inserted: same gene, same caller, no wait
SELECT is(
  (SELECT log_gene_invocation('c2222222-2222-4222-8222-222222222222', 'idem-caller-x')),
  (SELECT id FROM gene_invocation_log
    WHERE gene_id = 'c2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'idem-caller-x'),
  'T3: an immediate second report returns the existing row id, not a new one');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'c2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'idem-caller-x'),
  1::bigint,
  'T3b: still one row — the duplicate did not land');

-- T4 — a different caller is a different invocation
SELECT log_gene_invocation('c2222222-2222-4222-8222-222222222222', 'idem-caller-y');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'c2222222-2222-4222-8222-222222222222'),
  2::bigint,
  'T4: a second caller is recorded, not collapsed into the first');

-- T5 — the same caller on a different gene is a different invocation
SELECT log_gene_invocation('c3333333-3333-4333-8333-333333333333', 'idem-caller-x');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE caller_agent_id = 'idem-caller-x'),
  2::bigint,
  'T5: the same caller on another gene is recorded separately');

-- T6 — a genuine repeat, outside the window, MUST still be recorded.
--   Back-date the existing rows past the 5s window rather than sleeping.
--   This is the assertion that protects real usage data from a window that
--   someone later widens without thinking.
UPDATE gene_invocation_log
   SET invoked_at = now() - INTERVAL '10 seconds'
 WHERE gene_id = 'c2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'idem-caller-x';
SELECT log_gene_invocation('c2222222-2222-4222-8222-222222222222', 'idem-caller-x');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'c2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'idem-caller-x'),
  2::bigint,
  'T6: a repeat outside the window is a real invocation and is recorded');

-- T7 — the grant is unchanged: authenticated may still call it (20260527020805)
SELECT function_privs_are(
  'public', 'log_gene_invocation', ARRAY['uuid', 'text'],
  'authenticated', ARRAY['EXECUTE'],
  'T7: authenticated keeps EXECUTE — idempotency did not change who may report');

SELECT * FROM finish();

ROLLBACK;
