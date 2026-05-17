-- ============================================================
-- Bootstrap: enable pg_cron for dev/prod parity
-- ============================================================
--
-- WHY: subsequent migrations call cron.schedule(...) directly:
--   - 20260321210000_epoch_automation.sql           (v0.8)
--   - 20260322120000_contribution_metrics.sql       (v0.8)
--   - 20260516210000_v09_seasons.sql                (v0.9 stage-1, commented out)
--   - 20260517010000_v09_reset_season_impl.sql      (v0.9 stage-2)
--
-- In Supabase production, pg_cron is enabled via the Dashboard's
-- Extensions panel (manual click). Local `supabase start` does NOT
-- replicate that step automatically, so the dependent migrations fail
-- with `ERROR: schema "cron" does not exist (SQLSTATE 3F000)`.
--
-- This migration aligns local with production. Idempotent:
--   - CREATE EXTENSION IF NOT EXISTS    → no-op when already enabled
--   - GRANT USAGE / GRANT ALL ON TABLES → no-op when already granted
-- so applying it to production via `supabase db push` is safe (it will
-- be recorded in supabase_migrations.schema_migrations as applied with
-- zero schema impact).
--
-- TIMESTAMP: 20260101000000 puts this BEFORE all v0.8/v0.9 migrations
-- (earliest existing was 20260124120000_initial.sql) so dependent
-- cron.schedule(...) calls succeed when supabase reset / db push runs.
--
-- Schema choice: pg_catalog (per Supabase docs 2026-05; previous docs
-- recommended `extensions` schema but that has been corrected — see
-- https://github.com/supabase/supabase/issues/28261).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- Grant cron schema usage to postgres role for migration scripts.
-- supabase_admin already has these privileges; granting to postgres
-- ensures `supabase db reset` / migration playback works the same way.
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
