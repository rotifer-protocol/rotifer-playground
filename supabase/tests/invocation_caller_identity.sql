-- ============================================================
-- pgTAP tests for invocation caller identity (migration 20261021210000)
-- File: supabase/tests/invocation_caller_identity.sql
-- ============================================================
--
-- A client's report is recorded under its own account (auth.uid()), so one
-- account cannot pose as several callers to reach the verified tier's
-- unique_callers minimum, and an author cannot dodge the self-invocation
-- rule by naming someone else (T-63, audit F2). service_role keeps passing
-- the caller it chooses.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(8);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('e6311111-1111-4111-8111-111111111111', 'caller-x@example.com', '{"user_name": "caller_x"}'::jsonb),
  ('e6322222-2222-4222-8222-222222222222', 'author-y@example.com', '{"user_name": "author_y"}'::jsonb);

-- Author Y's published genes.
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('e63a0000-0000-4000-8000-00000000000a', 'e6322222-2222-4222-8222-222222222222', 'caller-a', 'test.caller', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('1', 64)),
  ('e63b0000-0000-4000-8000-00000000000b', 'e6322222-2222-4222-8222-222222222222', 'caller-b', 'test.caller', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('2', 64)),
  ('e63c0000-0000-4000-8000-00000000000c', 'e6322222-2222-4222-8222-222222222222', 'caller-c', 'test.caller', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('3', 64));

-- ── One account is one caller ───────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"e6311111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT log_gene_invocation_v2('e63a0000-0000-4000-8000-00000000000a', 'invented-agent-1', 'cli');
SELECT log_gene_invocation_v2('e63a0000-0000-4000-8000-00000000000a', 'invented-agent-2', 'cli');
SELECT log_gene_invocation_v2('e63a0000-0000-4000-8000-00000000000a', 'invented-agent-3', 'cli');
SELECT log_gene_invocation('e63b0000-0000-4000-8000-00000000000b', 'someone-else');

RESET ROLE;

SELECT is(
  (SELECT array_agg(DISTINCT caller_agent_id) FROM gene_invocation_log
    WHERE gene_id = 'e63a0000-0000-4000-8000-00000000000a'),
  ARRAY['e6311111-1111-4111-8111-111111111111']::TEXT[],
  'T1: three reports under three invented names are one caller — the account that sent them');

SELECT is(
  (SELECT caller_agent_id FROM gene_invocation_log WHERE gene_id = 'e63b0000-0000-4000-8000-00000000000b'),
  'e6311111-1111-4111-8111-111111111111',
  'T2: the original two-argument entry point records the account too');

-- ── An author is an author, whatever name they give ─────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"e6322222-2222-4222-8222-222222222222","role":"authenticated"}';
SELECT log_gene_invocation_v2('e63a0000-0000-4000-8000-00000000000a', 'not-the-author', 'cli');
RESET ROLE;

SELECT ok(
  (SELECT bool_and(is_self_invocation) FROM gene_invocation_log
    WHERE gene_id = 'e63a0000-0000-4000-8000-00000000000a'
      AND caller_agent_id = 'e6322222-2222-4222-8222-222222222222')
  AND NOT EXISTS (SELECT 1 FROM gene_invocation_log WHERE caller_agent_id = 'not-the-author'),
  'T3: the author''s own report is recorded as a self-invocation');

-- What the tier gate reads. With the season's minimum at 1 so the count is
-- visible (the default of 2 would hide a count of 1 as 0).
UPDATE seasons SET config = config || '{"min_unique_callers": 1}'::jsonb WHERE status = 'active';
SELECT refresh_contribution_metrics();
SELECT is(
  (SELECT unique_callers FROM gene_contribution_metrics WHERE gene_id = 'e63a0000-0000-4000-8000-00000000000a'),
  1,
  'T4: unique_callers is 1 — the invented names and the author''s own report do not count');

-- ── A client role without an account names nobody ───────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated"}';
SELECT throws_ok(
  $$ SELECT log_gene_invocation_v2('e63c0000-0000-4000-8000-00000000000c', 'nobody', 'cli') $$,
  '42501', NULL,
  'T5: a client report without a signed-in user is refused');
RESET ROLE;

-- ── service_role is not a client ─────────────────────────────

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT log_gene_invocation_v2('e63c0000-0000-4000-8000-00000000000c', 'binding:cloud-runtime', 'cloud');
RESET request.jwt.claims;
SELECT is(
  (SELECT caller_agent_id FROM gene_invocation_log WHERE gene_id = 'e63c0000-0000-4000-8000-00000000000c'),
  'binding:cloud-runtime',
  'T6: a service_role report keeps the caller it names');

-- ── anon cannot write the ledger at all ─────────────────────

SELECT ok(
  NOT has_function_privilege('anon', 'public.log_gene_invocation(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.log_gene_invocation_v2(uuid, text, text)', 'EXECUTE'),
  'T7: anon cannot call either entry point');

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$ INSERT INTO gene_invocation_log (gene_id, caller_agent_id)
     VALUES ('e63c0000-0000-4000-8000-00000000000c', 'anon-direct') $$,
  '42501', NULL,
  'T8: nor insert into gene_invocation_log directly');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
