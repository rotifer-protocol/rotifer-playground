-- ============================================================
-- pgTAP regression test: the daily season reset actually rolls a season over
-- File: supabase/tests/season_reset_cron.sql
-- ============================================================
--
-- The pg_cron job check-season-reset first marks an overdue active season
-- 'ending', then calls reset_season(). reset_season() looked only for
-- status = 'active', found nothing, raised 'No active season found', and the
-- whole command rolled back — every night from 2026-08-17 on, so season 1
-- never ended (T-82).
--
-- The command under test is the one pg_cron holds (cron.job.command), not a
-- copy of it: whatever runs at 01:00 UTC is what runs here.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(9);

-- The season the bootstrap migration opened, made overdue.
CREATE TEMP TABLE t_before AS
  SELECT id, season_number, config FROM seasons
   WHERE status = 'active' ORDER BY season_number DESC LIMIT 1;

UPDATE seasons
   SET started_at = now() - ((config->>'duration_days')::INTEGER + 1) * INTERVAL '1 day'
 WHERE id = (SELECT id FROM t_before);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f8211111-1111-4111-8111-111111111111', 'season-reset@example.com', '{"user_name": "season_reset"}'::jsonb);
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f82a0000-0000-4000-8000-00000000000a', 'f8211111-1111-4111-8111-111111111111', 'season-reset-gene', 'test.season', '0.1.0', 'Wrapped', '{}'::jsonb, true, repeat('a', 64));
INSERT INTO arena_entries (gene_id, domain, fitness_value, evaluation_method) VALUES
  ('f82a0000-0000-4000-8000-00000000000a', 'test.season', 0.8, 'estimated');

-- ── The nightly command, as registered ─────────────────────
SELECT lives_ok(
  (SELECT command FROM cron.job WHERE jobname = 'check-season-reset'),
  'T1: the registered check-season-reset command completes on an overdue season');

SELECT is(
  (SELECT status FROM seasons WHERE id = (SELECT id FROM t_before)),
  'ended',
  'T2: the overdue season is ended');

SELECT ok(
  (SELECT ended_at IS NOT NULL FROM seasons WHERE id = (SELECT id FROM t_before)),
  'T3: and has an ended_at');

SELECT is(
  (SELECT string_agg(season_number::text, ',') FROM seasons WHERE status IN ('active', 'ending')),
  ((SELECT season_number FROM t_before) + 1)::text,
  'T4: exactly one open season remains, the next number, and it is active');

SELECT ok(
  (SELECT config FROM seasons WHERE status = 'active') = (SELECT config FROM t_before),
  'T5: the new season carries the config forward unchanged');

SELECT ok(
  EXISTS (SELECT 1 FROM season_archives
           WHERE season_id = (SELECT id FROM t_before)
             AND gene_id = 'f82a0000-0000-4000-8000-00000000000a'
             AND final_fitness = 0.8),
  'T6: the ended season is archived with each published gene''s standing');

SELECT is(
  (SELECT round(fitness_value::numeric, 6)::text FROM arena_entries WHERE gene_id = 'f82a0000-0000-4000-8000-00000000000a'),
  (SELECT round((0.8 * (config->>'fitness_retention_rate')::DOUBLE PRECISION)::numeric, 6)::text FROM t_before),
  'T7: fitness carries over at the season''s fitness_retention_rate');

-- ── The next night: the new season is not due, nothing moves ──
CREATE TEMP TABLE t_after AS SELECT id, status, season_number FROM seasons;
SELECT lives_ok(
  (SELECT command FROM cron.job WHERE jobname = 'check-season-reset'),
  'T8: run again the next night, the command still completes');

SELECT ok(
  NOT EXISTS (
    (SELECT id, status, season_number FROM seasons EXCEPT SELECT * FROM t_after)
    UNION ALL
    (SELECT * FROM t_after EXCEPT SELECT id, status, season_number FROM seasons)),
  'T9: and changes nothing — the new season is not due, so nothing is reset twice');

SELECT * FROM finish();
ROLLBACK;
