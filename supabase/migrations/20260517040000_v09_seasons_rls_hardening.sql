-- ============================================================
-- v0.9: Season System — RLS hardening (B.7.2 + B.7.5)
-- Plan: protocol-v0.9-plan.md §3.2 · pgTAP suite supabase/tests/seasons.sql
-- ============================================================
--
-- Why this migration exists
-- -------------------------
-- 20260516210000_v09_seasons.sql sets up the schema, RLS policies and
-- *function-level* `REVOKE EXECUTE ... FROM anon`. Two pgTAP assertions kept
-- failing after stage 2 implementation landed:
--
--   B.2.8 / B.7.5 — `function_privs_are('public', 'reset_season', anon, [])`
--   B.7.2         — `table_privs_are('public', 'seasons', 'anon', ['SELECT'])`
--
-- Root causes (Postgres semantics, not Supabase quirks):
--
--   1. Functions default to `EXECUTE` granted to `PUBLIC`. Revoking from `anon`
--      alone leaves the privilege intact because `anon` inherits from `PUBLIC`.
--      We must `REVOKE EXECUTE ... FROM PUBLIC` to actually drop it.
--
--   2. `ENABLE ROW LEVEL SECURITY` only intercepts row-level access. It does
--      *not* drop the *table-level* GRANT — Supabase's bootstrap grants
--      `INSERT/UPDATE/DELETE` to `anon` and `authenticated` for every public
--      table, so `table_privs_are(... ['SELECT'])` fails until we explicitly
--      `REVOKE`.
--
-- What this migration does
-- ------------------------
--   • Tighten table privileges so anon/authenticated only retain `SELECT` on
--     `seasons` + `season_archives` (matches the read-only RLS policies).
--   • Re-grant `ALL` to `service_role` to keep the existing write path intact.
--   • Drop `EXECUTE` on the four v0.9 RPCs from `PUBLIC`, then re-grant to
--     `service_role` (mirrors plan §3.2 expectation).
--
-- Idempotent: every statement is safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. seasons / season_archives — table-level privileges
-- ------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE seasons         FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE seasons         FROM anon;
REVOKE ALL PRIVILEGES ON TABLE seasons         FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE season_archives FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE season_archives FROM anon;
REVOKE ALL PRIVILEGES ON TABLE season_archives FROM authenticated;

GRANT SELECT ON TABLE seasons         TO anon, authenticated;
GRANT SELECT ON TABLE season_archives TO anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE seasons         TO service_role;
GRANT ALL PRIVILEGES ON TABLE season_archives TO service_role;

-- The seasons.id column is SERIAL → owns a sequence we never expose to anon.
-- Default seq grants survive table revoke; tighten explicitly.
REVOKE ALL PRIVILEGES ON SEQUENCE seasons_id_seq FROM PUBLIC, anon, authenticated;
GRANT  USAGE, SELECT ON SEQUENCE seasons_id_seq TO service_role;

-- ------------------------------------------------------------
-- 2. v0.9 RPC functions — execute privileges
-- ------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION reset_season()                                    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reset_season()                                    FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_display_fitness(UUID)                         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_display_weight(UUID)                          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION compute_path_diversity(UUID, TEXT)                FROM PUBLIC;

GRANT EXECUTE ON FUNCTION reset_season()                                     TO service_role;
GRANT EXECUTE ON FUNCTION get_display_fitness(UUID)                          TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_display_weight(UUID)                           TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION compute_path_diversity(UUID, TEXT)                 TO anon, authenticated, service_role;
