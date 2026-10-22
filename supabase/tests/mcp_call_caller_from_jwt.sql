-- ============================================================
-- pgTAP tests for migration 20261022130000 (T-74)
-- File: supabase/tests/mcp_call_caller_from_jwt.sql
-- ============================================================
--
-- log_mcp_call() bumps arena_entries.total_calls for the gene it names. A
-- signed-in report is recorded under auth.uid() whatever p_caller says; an
-- unsigned one is accepted and not recorded; one account adds at most 10 a
-- minute to one gene however many tool names it uses.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(9);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f7411111-1111-4111-8111-111111111111', 'mcp-caller-a@example.com', '{"user_name": "mcp_caller_a"}'::jsonb),
  ('f7422222-2222-4222-8222-222222222222', 'mcp-caller-b@example.com', '{"user_name": "mcp_caller_b"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f74a0000-0000-4000-8000-00000000000a', 'f7422222-2222-4222-8222-222222222222', 'mcp-caller-gene', 'test.mcpcaller', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('a', 64));
INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method) VALUES
  ('f74a0000-0000-4000-8000-00000000000a', 'test.mcpcaller', 0.5, 'estimated');

-- ── Signed in ──────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f7411111-1111-4111-8111-111111111111","role":"authenticated"}';

-- A names B as the caller.
SELECT log_mcp_call('get_gene_detail', 'f74a0000-0000-4000-8000-00000000000a', true, 5,
                    'f7422222-2222-4222-8222-222222222222');
RESET ROLE;
RESET request.jwt.claims;

SELECT is(
  (SELECT string_agg(caller, ',') FROM mcp_call_log WHERE gene_id = 'f74a0000-0000-4000-8000-00000000000a'),
  'f7411111-1111-4111-8111-111111111111',
  'T1: a signed-in report is recorded under the account that sent it, not the caller it names');

SELECT is(
  (SELECT total_calls FROM arena_entries WHERE gene_id = 'f74a0000-0000-4000-8000-00000000000a')::text, '1',
  'T2: and it counts once toward total_calls');

-- ── Not signed in (anon key only, as MCP server releases before T-74 send) ──
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT lives_ok(
  $$ SELECT log_mcp_call('get_gene_detail', 'f74a0000-0000-4000-8000-00000000000a', true, 5,
                         'f7422222-2222-4222-8222-222222222222') $$,
  'T3: an unsigned report does not fail, so an older MCP server keeps working');
SELECT lives_ok(
  $$ SELECT log_mcp_call('get_gene_detail', 'f74a0000-0000-4000-8000-00000000000a', true, 5, 'made-up-caller') $$,
  'T4: whatever caller it names');
RESET ROLE;
RESET request.jwt.claims;

SELECT ok(
  (SELECT count(*) FROM mcp_call_log WHERE gene_id = 'f74a0000-0000-4000-8000-00000000000a') = 1
  AND (SELECT total_calls FROM arena_entries WHERE gene_id = 'f74a0000-0000-4000-8000-00000000000a') = 1,
  'T5: but it is not recorded and does not count');

-- ── One account, one gene, many tool names ─────────────────
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f7411111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT log_mcp_call('tool-' || i, 'f74a0000-0000-4000-8000-00000000000a', true, 5, 'cycle-' || i)
  FROM generate_series(1, 15) AS i;
RESET ROLE;
RESET request.jwt.claims;

SELECT is(
  (SELECT total_calls FROM arena_entries WHERE gene_id = 'f74a0000-0000-4000-8000-00000000000a')::text, '10',
  'T6: one account adds at most 10 a minute to one gene, however many tool names and caller strings it cycles');

SELECT ok(
  NOT EXISTS (SELECT 1 FROM mcp_call_log WHERE caller LIKE 'cycle-%' OR caller = 'made-up-caller'),
  'T7: no self-reported caller string was recorded');

-- ── Without a gene, the limit stays per tool ───────────────
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f7422222-2222-4222-8222-222222222222","role":"authenticated"}';
SELECT log_mcp_call('search_genes', NULL, true, 5, NULL) FROM generate_series(1, 3);
RESET ROLE;
RESET request.jwt.claims;

SELECT is(
  (SELECT count(*) FROM mcp_call_log WHERE tool_name = 'search_genes' AND caller = 'f7422222-2222-4222-8222-222222222222')::text, '3',
  'T8: a call without a gene is recorded under its account');

-- ── Server side ────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT log_mcp_call('server_probe', NULL, true, 1, 'server-job');
RESET request.jwt.claims;

SELECT ok(
  EXISTS (SELECT 1 FROM mcp_call_log WHERE tool_name = 'server_probe' AND caller = 'server-job'),
  'T9: service_role still records the caller it passes');

SELECT * FROM finish();
ROLLBACK;
