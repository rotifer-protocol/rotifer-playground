-- profiles: bring the migration chain in line with the live column.
--
-- Production renamed profiles.github_id to provider_id (text) when GitLab auth
-- was added, and redefined handle_new_user to match. That was applied straight
-- to the database — the ledger has no record of it, and no migration here ever
-- did it. So a database built from this chain alone ends up with
-- `github_id bigint` and a trigger writing to it, while production has
-- `provider_id text`. The CI replay job has been proving that chain green
-- against a shape production does not have.
--
-- This is one instance of the reverse-parity debt that
-- 20260531022500_pin_search_path_5_funcs.sql already had to work around, in
-- its own words: "some of these functions exist in production but predate the
-- local migration chain (created via dashboard / orphan migrations)".
--
-- Add-only and idempotent. Against production both halves are no-ops: the
-- column is already renamed, and the function body below is transcribed from
-- the live definition, so CREATE OR REPLACE rewrites it to what it already is.
-- What changes is what a from-scratch replay produces.

-- 1. The column. Guarded both ways so this is safe whichever state it meets.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'github_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'provider_id'
  ) THEN
    ALTER TABLE public.profiles RENAME COLUMN github_id TO provider_id;
    ALTER TABLE public.profiles ALTER COLUMN provider_id TYPE text USING provider_id::text;
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_github_id_key;
  END IF;
END $$;

-- 2. The trigger function. Renaming the column alone would leave a replayed
-- database with a trigger inserting into a column that no longer exists —
-- every sign-up would fail. Body transcribed from the live definition
-- (2026-09-01), including its pinned empty search_path.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $fn$
BEGIN
  INSERT INTO public.profiles (id, username, avatar_url, provider_id)
  VALUES (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'user_name',
      new.raw_user_meta_data->>'preferred_username',
      new.raw_user_meta_data->>'nickname',
      new.raw_user_meta_data->>'name',
      (new.raw_user_meta_data->>'email')::text,
      'user_' || substr(new.id::text, 1, 8)
    ),
    new.raw_user_meta_data->>'avatar_url',
    coalesce(
      new.raw_user_meta_data->>'provider_id',
      new.raw_user_meta_data->>'sub',
      ''
    )
  )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    avatar_url = EXCLUDED.avatar_url,
    provider_id = EXCLUDED.provider_id,
    updated_at = now();
  RETURN new;
END;
$fn$;
