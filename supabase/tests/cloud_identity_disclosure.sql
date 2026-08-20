-- ============================================================
-- pgTAP tests for the publishing-identity disclosure (ADR-323 D3)
-- File: supabase/tests/cloud_identity_disclosure.sql
-- ============================================================
--
-- Migration 20260819250000. `profiles` could say who an account *is* and
-- nothing about who *holds* it, so `rotifer-protocol` read as an organisation
-- with nowhere to record that it is one person. The roundtable kept the name
-- 5:0 and made this column the condition.
--
-- The ownership migration itself (20260819260000) is guarded to production
-- UUIDs and no-ops elsewhere, so it cannot be exercised here. What is testable
-- is the shape the disclosure has to hold, and the invariant the migration
-- depends on: the username is UNIQUE, which is why the dead identity must
-- release the name before the live one can take it. T4 pins that, because a
-- migration whose steps are order-dependent should have the reason for the
-- order written down as an assertion rather than a comment.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(6);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('d1111111-1111-4111-8111-111111111111', 'ident-a@example.com', '{"user_name": "ident_a"}'::jsonb),
  ('d2222222-2222-4222-8222-222222222222', 'ident-b@example.com', '{"user_name": "ident_b"}'::jsonb);

-- T1: the column exists and holds text
SELECT has_column('public', 'profiles', 'steward_note', 'T1: profiles can record who holds the identity');

-- T2: null is the resting state — nothing to disclose is not an empty disclosure
SELECT is((SELECT steward_note FROM profiles WHERE id = 'd1111111-1111-4111-8111-111111111111'),
  NULL, 'T2: a profile with nothing to disclose stores null, not an empty string');

-- T3: a real disclosure round-trips
UPDATE profiles
   SET steward_note = 'Operated by one person. Its predecessor was banned and 59 genes were moved here.'
 WHERE id = 'd1111111-1111-4111-8111-111111111111';
SELECT matches((SELECT steward_note FROM profiles WHERE id = 'd1111111-1111-4111-8111-111111111111'),
  'one person', 'T3: the disclosure survives a write and a read');

-- T4: the invariant that dictates the migration''s step order
SELECT throws_ok(
  $$ UPDATE profiles SET username = (SELECT username FROM profiles WHERE id = 'd1111111-1111-4111-8111-111111111111')
      WHERE id = 'd2222222-2222-4222-8222-222222222222' $$,
  '23505',
  NULL,
  'T4: two profiles cannot share a username — the dead identity must release the name first');

-- T5: the bound is enforced, so a public anon-readable column cannot be used as storage
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note = repeat('x', 501)
      WHERE id = 'd1111111-1111-4111-8111-111111111111' $$,
  '23514',
  NULL,
  'T5: a disclosure over 500 characters is rejected');

-- T6: exactly at the bound is fine — an off-by-one here would silently truncate
--     the real disclosure, which is 400-odd characters.
SELECT lives_ok(
  $$ UPDATE profiles SET steward_note = repeat('y', 500)
      WHERE id = 'd1111111-1111-4111-8111-111111111111' $$,
  'T6: 500 characters exactly is accepted');

SELECT * FROM finish();
ROLLBACK;
