-- ============================================================
-- pgTAP tests for profiles.provider_id replay parity
-- File: supabase/tests/profiles_provider_id_replay_parity.sql
-- ============================================================
--
-- Production renamed profiles.github_id to provider_id (text) when GitLab
-- auth was added, and redefined handle_new_user to match — straight to the
-- database, with no migration and no ledger entry. This chain therefore
-- built `github_id bigint` and a trigger writing to it, while production had
-- `provider_id text`, and the replay job proved that chain green for months
-- against a shape production does not have.
--
-- These assertions run against the replayed database, so they are the thing
-- that would have caught it. They are cheap and they are about the schema
-- the whole auth path depends on: a sign-up writes through this column.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(5);

-- T1/T2: the column, by name and type. Type matters as much as presence —
-- production widened it from bigint to text so non-numeric provider ids
-- (GitLab nicknames, email subjects) fit.
SELECT has_column('public', 'profiles', 'provider_id', 'profiles has provider_id');
SELECT col_type_is('public', 'profiles', 'provider_id', 'text', 'provider_id is text, not bigint');

-- T3: the old name is gone. Without this, a chain that added provider_id
-- while leaving github_id behind would pass T1 and still not match
-- production.
SELECT hasnt_column('public', 'profiles', 'github_id', 'the pre-rename github_id column is gone');

-- T4: the trigger function exists. Renaming the column while leaving
-- handle_new_user writing to the old one would break every sign-up, and the
-- column assertions above would not notice.
SELECT has_function('public', 'handle_new_user', 'handle_new_user() exists');

-- T5: and it actually writes to the new column. This is the assertion that
-- ties the two halves together — it reads the installed function body rather
-- than trusting that whoever renamed the column remembered the trigger.
SELECT ok(
  (SELECT prosrc LIKE '%provider_id%' AND prosrc NOT LIKE '%github_id%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_user'),
  'handle_new_user writes provider_id and no longer references github_id'
);

SELECT * FROM finish();
ROLLBACK;
