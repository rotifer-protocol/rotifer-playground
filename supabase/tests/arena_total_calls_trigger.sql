-- ============================================================
-- pgTAP tests for update_arena_total_calls() (mcp_call_log -> arena_entries)
-- File: supabase/tests/arena_total_calls_trigger.sql
-- ============================================================
--
-- Regression for migration 20260815130000. Before it, the trigger compared
-- uuid = text without a cast, so any log_mcp_call() carrying a gene id aborted
-- the INSERT (`operator does not exist: uuid = text`) and total_calls never
-- moved. T3 is the assertion that used to fail.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(8);

-- ------------------------------------------------------------
-- Fixture: one user (profile auto-created by handle_new_user), one published
-- gene, one arena entry. Rolled back at the end.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('11111111-1111-4111-8111-111111111111', 'arena-trigger-test@example.com',
        '{"user_name": "arena_trigger_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'arena-trigger-test-gene', 'test.trigger', '0.1.0', 'Wrapped',
        '{"domain":"test.trigger","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('a', 64));

INSERT INTO arena_entries (gene_id, domain, fitness_value)
VALUES ('22222222-2222-4222-8222-222222222222', 'test.trigger', 0.5);

-- T1/T2 — the wiring is present
SELECT has_function('public', 'update_arena_total_calls',
  'T1: update_arena_total_calls() exists');
SELECT has_trigger('public', 'mcp_call_log', 'trg_update_arena_total_calls',
  'T2: trigger bound to mcp_call_log');

-- T3/T4 — a call log with a uuid gene_id inserts and increments (the bug)
SELECT lives_ok(
  $$ SELECT log_mcp_call('run_gene', '22222222-2222-4222-8222-222222222222', true, 10, 'arena-trigger-tester') $$,
  'T3: log_mcp_call with a uuid gene_id no longer aborts on uuid = text');
SELECT is(
  (SELECT total_calls FROM arena_entries WHERE gene_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'T4: total_calls incremented to 1');

-- T5/T6 — a directory name (what rotifer-mcp-server <= 0.16.0 sent) is tolerated, not counted
SELECT lives_ok(
  $$ SELECT log_mcp_call('run_gene', 'json-validator', true, 10, 'arena-trigger-tester') $$,
  'T5: non-uuid gene_id inserts without error');
SELECT is(
  (SELECT total_calls FROM arena_entries WHERE gene_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'T6: non-uuid gene_id does not increment anything');

-- T7/T8 — NULL gene_id still inserts, still counts nothing
SELECT lives_ok(
  $$ SELECT log_mcp_call('search_genes', NULL, true, 5, 'arena-trigger-tester') $$,
  'T7: NULL gene_id inserts');
SELECT is(
  (SELECT count(*) FROM mcp_call_log WHERE caller = 'arena-trigger-tester'),
  3::bigint,
  'T8: all three log_mcp_call() rows landed');

SELECT * FROM finish();

ROLLBACK;
