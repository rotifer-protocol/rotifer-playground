-- ============================================================
-- pgTAP tests for the closed-account write guard (migration 20261022110000)
-- File: supabase/tests/closed_account_writes.sql
-- ============================================================
--
-- An access token issued before close_account() stays valid until it
-- expires. Every write it makes — directly or through a client RPC — is
-- refused; another account's writes on the closed account's kept genes are
-- not. The refusals are matched by message, so another guard on the same
-- table refusing for a reason of its own cannot pass for this one.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(14);

-- A will be closed. B stays open.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f6911111-1111-4111-8111-111111111111', 'closed-writes-a@example.com', '{"user_name": "closed_writes_a"}'::jsonb),
  ('f6922222-2222-4222-8222-222222222222', 'closed-writes-b@example.com', '{"user_name": "closed_writes_b"}'::jsonb);

-- kept: A's, published, invoked by B, so it stays published after closure.
-- draft: A's, never published. bgene: B's.
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f69a0000-0000-4000-8000-00000000000a', 'f6911111-1111-4111-8111-111111111111', 'cw-kept',  'test.closedwrites', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('1', 64)),
  ('f69b0000-0000-4000-8000-00000000000b', 'f6911111-1111-4111-8111-111111111111', 'cw-draft', 'test.closedwrites', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('2', 64)),
  ('f69c0000-0000-4000-8000-00000000000c', 'f6922222-2222-4222-8222-222222222222', 'cw-bgene', 'test.closedwrites', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('3', 64));

INSERT INTO gene_invocation_log (gene_id, caller_agent_id, gene_author_id) VALUES
  ('f69a0000-0000-4000-8000-00000000000a', 'f6922222-2222-4222-8222-222222222222', 'f6911111-1111-4111-8111-111111111111');

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT * FROM close_account('f6911111-1111-4111-8111-111111111111', 'user_request');
RESET request.jwt.claims;

-- ── A's leftover token ─────────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f6911111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT throws_ok(
  $$ INSERT INTO genes (owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
     VALUES ('f6911111-1111-4111-8111-111111111111', 'cw-new', 'test.closedwrites', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('4', 64)) $$,
  '42501', 'this account is closed and can no longer write',
  'T1: a closed account cannot publish a gene');

SELECT throws_ok(
  $$ SELECT * FROM unpublish_gene('f69a0000-0000-4000-8000-00000000000a', 'after closure') $$,
  '42501', 'this account is closed and can no longer write',
  'T2: nor take down the gene that was kept published for others');

SELECT throws_ok(
  $$ DELETE FROM genes WHERE id = 'f69b0000-0000-4000-8000-00000000000b' $$,
  '42501', 'this account is closed and can no longer write',
  'T3: nor delete its draft');

SELECT throws_ok(
  $$ INSERT INTO api_keys (owner_id, key_hash, key_prefix, name)
     VALUES ('f6911111-1111-4111-8111-111111111111', repeat('e', 64), 'rk_test_', 'after closure') $$,
  '42501', 'this account is closed and can no longer write',
  'T4: nor create an API key that would outlive the token');

SELECT throws_ok(
  $$ INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method)
     VALUES ('f69a0000-0000-4000-8000-00000000000a', 'test.closedwrites', 0.9, 'estimated') $$,
  '42501', 'this account is closed and can no longer write',
  'T5: nor submit to the Arena');

SELECT throws_ok(
  $$ INSERT INTO arena_evaluation_runs (gene_id, submission_id, run_index, sandbox_success, latency_ms, resource_cost)
     VALUES ('f69a0000-0000-4000-8000-00000000000a', 'f69aaaaa-0000-4000-8000-000000000001', 0, true, 1, 1) $$,
  '42501', 'this account is closed and can no longer write',
  'T6: nor record evaluation runs');

SELECT throws_ok(
  $$ INSERT INTO domain_registry (domain, created_by)
     VALUES ('test.closedwrites.new', 'f6911111-1111-4111-8111-111111111111') $$,
  '42501', 'this account is closed and can no longer write',
  'T7: nor register a domain');

SELECT throws_ok(
  $$ SELECT log_gene_invocation('f69c0000-0000-4000-8000-00000000000c', 'f6911111-1111-4111-8111-111111111111') $$,
  '42501', 'this account is closed and can no longer write',
  'T8: nor report an invocation of someone else''s gene (it would count as a distinct caller)');

SELECT throws_ok(
  $$ SELECT track_download('f69c0000-0000-4000-8000-00000000000c'::uuid, 'cli') $$,
  '42501', 'this account is closed and can no longer write',
  'T9: nor record a download');

SELECT throws_ok(
  $$ SELECT log_mcp_call('get_gene_detail', 'f69c0000-0000-4000-8000-00000000000c', true, 5, 'f6911111-1111-4111-8111-111111111111') $$,
  '42501', 'this account is closed and can no longer write',
  'T10: nor log an MCP call');

-- ── Another account, on the closed account's kept gene ─────
SET LOCAL request.jwt.claims = '{"sub":"f6922222-2222-4222-8222-222222222222","role":"authenticated"}';

SELECT lives_ok(
  $$ SELECT log_gene_invocation('f69a0000-0000-4000-8000-00000000000a', 'f6922222-2222-4222-8222-222222222222') $$,
  'T11: another account can still report invoking the kept gene');

SELECT lives_ok(
  $$ SELECT track_download('f69a0000-0000-4000-8000-00000000000a'::uuid, 'cli') $$,
  'T12: and download it');

SELECT lives_ok(
  $$ INSERT INTO genes (owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
     VALUES ('f6922222-2222-4222-8222-222222222222', 'cw-b-new', 'test.closedwrites', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('5', 64)) $$,
  'T13: and an open account publishes as before');
RESET ROLE;
RESET request.jwt.claims;

SELECT ok(
  (SELECT published FROM genes WHERE id = 'f69a0000-0000-4000-8000-00000000000a')
  AND EXISTS (SELECT 1 FROM genes WHERE id = 'f69b0000-0000-4000-8000-00000000000b')
  AND NOT EXISTS (SELECT 1 FROM api_keys WHERE owner_id = 'f6911111-1111-4111-8111-111111111111')
  AND NOT EXISTS (SELECT 1 FROM gene_invocation_log
                   WHERE caller_agent_id = 'f6911111-1111-4111-8111-111111111111'),
  'T14: none of the closed account''s writes landed');

SELECT * FROM finish();
ROLLBACK;
