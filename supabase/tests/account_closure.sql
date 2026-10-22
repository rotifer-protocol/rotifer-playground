-- ============================================================
-- pgTAP tests for account closure (migration 20261022100000)
-- File: supabase/tests/account_closure.sql
-- ============================================================
--
-- Deleting a user cascades to every gene it published (spec §16.4, §16.5
-- MUST: genes outlive the agent). close_account() archives the genes only the
-- account used, keeps the ones others used, keeps every record, anonymizes the
-- profile and writes a legacy record; deleting a profile that owns genes is
-- refused for every role (T-68).
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(16);

-- A closes. B uses some of A's genes. C owns nothing.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f6811111-1111-4111-8111-111111111111', 'closure-a@example.com',
   '{"user_name": "closure_a", "avatar_url": "https://example.com/a.png", "sub": "4242"}'::jsonb),
  ('f6822222-2222-4222-8222-222222222222', 'closure-b@example.com', '{"user_name": "closure_b"}'::jsonb),
  ('f6833333-3333-4333-8333-333333333333', 'closure-c@example.com', '{"user_name": "closure_c"}'::jsonb);

UPDATE profiles SET steward_note = 'runs on my laptop'
 WHERE id = 'f6811111-1111-4111-8111-111111111111';

-- excl: published, only A invoked it. inv: published, B invoked it.
-- dl: published, downloaded anonymously. draft: never published.
-- b-gene: B's, downloaded by A.
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f68a0000-0000-4000-8000-00000000000a', 'f6811111-1111-4111-8111-111111111111', 'close-excl',  'test.closure', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('a', 64)),
  ('f68b0000-0000-4000-8000-00000000000b', 'f6811111-1111-4111-8111-111111111111', 'close-inv',   'test.closure', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('b', 64)),
  ('f68c0000-0000-4000-8000-00000000000c', 'f6811111-1111-4111-8111-111111111111', 'close-dl',    'test.closure', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('c', 64)),
  ('f68d0000-0000-4000-8000-00000000000d', 'f6811111-1111-4111-8111-111111111111', 'close-draft', 'test.closure', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('d', 64)),
  ('f68e0000-0000-4000-8000-00000000000e', 'f6822222-2222-4222-8222-222222222222', 'close-bgene', 'test.closure', '0.1.0', 'Wrapped', '{}'::jsonb, true,  repeat('e', 64));

INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method) VALUES
  ('f68a0000-0000-4000-8000-00000000000a', 'test.closure', 0.4, 'estimated');

INSERT INTO gene_invocation_log (gene_id, caller_agent_id, gene_author_id) VALUES
  ('f68a0000-0000-4000-8000-00000000000a', 'f6811111-1111-4111-8111-111111111111', 'f6811111-1111-4111-8111-111111111111'),
  ('f68b0000-0000-4000-8000-00000000000b', 'f6822222-2222-4222-8222-222222222222', 'f6811111-1111-4111-8111-111111111111');

INSERT INTO downloads (gene_id, user_id) VALUES
  ('f68c0000-0000-4000-8000-00000000000c', NULL),
  ('f68e0000-0000-4000-8000-00000000000e', 'f6811111-1111-4111-8111-111111111111');

INSERT INTO api_keys (owner_id, key_hash, key_prefix, name) VALUES
  ('f6811111-1111-4111-8111-111111111111', repeat('f', 64), 'rk_test_', 'closure test key');

SELECT compute_developer_reputation('f6811111-1111-4111-8111-111111111111');

-- ── Who may close ──────────────────────────────────────────
SELECT ok(
  has_function_privilege('service_role', 'close_account(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'close_account(uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'close_account(uuid, text)', 'EXECUTE'),
  'T1: close_account() is executable by service_role only');

-- ── The delete that bypasses closure ───────────────────────
SELECT throws_ok(
  $$ DELETE FROM auth.users WHERE id = 'f6811111-1111-4111-8111-111111111111' $$,
  '42501', NULL,
  'T2: deleting the auth user of an account that owns genes is refused (the cascade reaches profiles)');

SELECT throws_ok(
  $$ DELETE FROM profiles WHERE id = 'f6811111-1111-4111-8111-111111111111' $$,
  '42501', NULL,
  'T3: so is deleting its profile directly');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f6811111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT throws_ok(
  $$ UPDATE profiles SET closed_at = now() WHERE id = 'f6811111-1111-4111-8111-111111111111' $$,
  '42501', NULL,
  'T4: a client cannot mark its own profile closed');
RESET ROLE;

-- ── Closing ────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT lives_ok(
  $$ CREATE TEMP TABLE closed AS
       SELECT * FROM close_account('f6811111-1111-4111-8111-111111111111', 'user_request') $$,
  'T5: service_role closes the account');

SELECT is(
  (SELECT archived_genes::text || '/' || kept_genes::text FROM closed), '1/2',
  'T6: one exclusive gene archived, two genes others used kept');

SELECT ok(
  (SELECT NOT published FROM genes WHERE id = 'f68a0000-0000-4000-8000-00000000000a')
  AND (SELECT published FROM genes WHERE id = 'f68b0000-0000-4000-8000-00000000000b')
  AND (SELECT published FROM genes WHERE id = 'f68c0000-0000-4000-8000-00000000000c')
  AND (SELECT NOT published FROM genes WHERE id = 'f68d0000-0000-4000-8000-00000000000d'),
  'T7: the exclusive gene is unpublished; the invoked and the downloaded ones stay published; the draft stays a draft');

SELECT ok(
  EXISTS (SELECT 1 FROM gene_visibility_log
           WHERE gene_id = 'f68a0000-0000-4000-8000-00000000000a'
             AND actor_id = 'f6811111-1111-4111-8111-111111111111'
             AND action = 'unpublish' AND reason = 'account closed')
  AND NOT EXISTS (SELECT 1 FROM gene_visibility_log
                   WHERE gene_id IN ('f68b0000-0000-4000-8000-00000000000b', 'f68c0000-0000-4000-8000-00000000000c')),
  'T8: the archive is on the audit trail, as unpublish_gene() would have written it; the kept genes have no entry');

SELECT ok(
  (SELECT count(*) FROM genes WHERE owner_id = 'f6811111-1111-4111-8111-111111111111') = 4
  AND EXISTS (SELECT 1 FROM arena_entries WHERE gene_id = 'f68a0000-0000-4000-8000-00000000000a')
  AND (SELECT count(*) FROM gene_invocation_log
        WHERE gene_id IN ('f68a0000-0000-4000-8000-00000000000a', 'f68b0000-0000-4000-8000-00000000000b')) = 2
  AND (SELECT count(*) FROM downloads WHERE gene_id = 'f68e0000-0000-4000-8000-00000000000e') = 1
  AND EXISTS (SELECT 1 FROM developer_reputation WHERE user_id = 'f6811111-1111-4111-8111-111111111111'),
  'T9: every gene, the Arena row, the invocation rows, the download count and the reputation row are kept');

SELECT ok(
  (SELECT username = 'closed_f6811111111141118111111111111111'
          AND avatar_url IS NULL AND provider_id = ''
          AND steward_note IS NULL AND steward_note_i18n IS NULL
          AND closed_at IS NOT NULL
     FROM profiles WHERE id = 'f6811111-1111-4111-8111-111111111111')
  AND NOT EXISTS (SELECT 1 FROM api_keys WHERE owner_id = 'f6811111-1111-4111-8111-111111111111')
  AND NOT EXISTS (SELECT 1 FROM downloads WHERE user_id = 'f6811111-1111-4111-8111-111111111111'),
  'T10: the profile no longer names the person, its API keys are gone, its downloads are detached');

SELECT ok(
  (SELECT termination_reason = 'user_request'
          AND reputation_snapshot IS NOT NULL
          AND jsonb_array_length(gene_contributions) = 3
          AND gene_contributions @> '[{"gene_id": "f68a0000-0000-4000-8000-00000000000a", "role": "AUTHOR", "fitness_at_termination": 0.4, "state_after": "ARCHIVED"}]'::jsonb
          AND gene_contributions @> '[{"gene_id": "f68b0000-0000-4000-8000-00000000000b", "state_after": "PUBLISHED"}]'::jsonb
          AND NOT gene_contributions @> '[{"gene_id": "f68d0000-0000-4000-8000-00000000000d"}]'::jsonb
          AND id = (SELECT legacy_record_id FROM closed)
     FROM account_legacy_records WHERE account_id = 'f6811111-1111-4111-8111-111111111111'),
  'T11: the legacy record lists the three published genes (not the draft) with their state and fitness, and the reputation at closure');

SELECT throws_ok(
  $$ SELECT * FROM close_account('f6811111-1111-4111-8111-111111111111', 'user_request') $$,
  '22023', NULL,
  'T12: closing an account twice is refused');
RESET request.jwt.claims;

-- ── After closing ──────────────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"f6811111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT throws_ok(
  $$ UPDATE profiles SET username = 'closure_a' WHERE id = 'f6811111-1111-4111-8111-111111111111' $$,
  '42501', NULL,
  'T13: a token issued before closure cannot rename the closed profile back');

SELECT throws_ok(
  $$ INSERT INTO account_legacy_records (account_id, termination_reason)
     VALUES ('f6833333-3333-4333-8333-333333333333', 'operator') $$,
  '42501', NULL,
  'T14: a client cannot write a legacy record');
RESET ROLE;
RESET request.jwt.claims;

SELECT throws_ok(
  $$ DELETE FROM auth.users WHERE id = 'f6811111-1111-4111-8111-111111111111' $$,
  '42501', NULL,
  'T15: a closed account that still owns genes still cannot be hard-deleted');

SELECT lives_ok(
  $$ DELETE FROM auth.users WHERE id = 'f6833333-3333-4333-8333-333333333333' $$,
  'T16: an account that owns no gene can still be deleted');

SELECT * FROM finish();
ROLLBACK;
