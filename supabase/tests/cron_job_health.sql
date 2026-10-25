-- ============================================================
-- pgTAP tests for cron_job_health() (migration 20261025110000, T-82)
-- File: supabase/tests/cron_job_health.sql
-- ============================================================
--
-- The daily health workflow reads this with the publishable key, so anon
-- must be able to call it, it must count failures since the last success
-- (the shape of the season-reset outage: one success, then failure after
-- failure), it must flag a job that has stopped running altogether (a
-- stopped scheduler leaves no failures, only silence), and it must not hand
-- out the command text or error messages.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(14);

SELECT ok(
  has_function_privilege('anon', 'cron_job_health()', 'EXECUTE'),
  'T1: anon can call cron_job_health() — the workflow uses the publishable key');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.routines r
      JOIN information_schema.parameters p USING (specific_schema, specific_name)
     WHERE r.routine_schema = 'public' AND r.routine_name = 'cron_job_health'
       AND p.parameter_mode = 'OUT'
       AND p.parameter_name IN ('command', 'return_message', 'database', 'username')),
  'T2: it returns no command text, error message, database or username');

-- The outage, reproduced in the run log: one success, then two failures.
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
SELECT j.jobid, r.runid, 0, current_database(), current_user, j.command, r.status, r.msg, r.t, r.t
  FROM cron.job j,
       (VALUES (-9001::bigint, 'succeeded', '0 rows',                       now() - interval '3 days'),
               (-9002::bigint, 'failed',    'ERROR: No active season found', now() - interval '2 days'),
               (-9003::bigint, 'failed',    'ERROR: No active season found', now() - interval '1 day'))
         AS r(runid, status, msg, t)
 WHERE j.jobname = 'check-season-reset';

SET LOCAL ROLE anon;
SELECT is(
  (SELECT last_status FROM cron_job_health() WHERE jobname = 'check-season-reset'),
  'failed',
  'T3: the last status of a failing job reads failed');

SELECT is(
  (SELECT failures_since_success::text FROM cron_job_health() WHERE jobname = 'check-season-reset'),
  '2',
  'T4: failures since the last success are counted');

SELECT ok(
  (SELECT last_succeeded_at < last_run_at FROM cron_job_health() WHERE jobname = 'check-season-reset'),
  'T5: the last success is older than the last run');
RESET ROLE;

-- A success resets the count.
INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
SELECT j.jobid, -9004, 0, current_database(), current_user, j.command, 'succeeded', '1 row', now(), now()
  FROM cron.job j WHERE j.jobname = 'check-season-reset';

SELECT is(
  (SELECT failures_since_success::text FROM cron_job_health() WHERE jobname = 'check-season-reset'),
  '0',
  'T6: a later success brings the count back to zero');

-- ── Overdue: how long a schedule may leave between runs ─────
SELECT is(cron_schedule_max_gap('0 1 * * *')::text,   '1 day',    'T7: a daily schedule allows a 1-day gap');
SELECT is(cron_schedule_max_gap('*/5 * * * *')::text, '00:05:00', 'T8: every 5 minutes allows a 5-minute gap');
SELECT is(cron_schedule_max_gap('30 seconds')::text,  '00:00:30', 'T9: pg_cron''s seconds form is understood');
SELECT is(cron_schedule_max_gap('0 3 * * 1')::text,   '7 days',   'T10: a weekly schedule allows a 7-day gap');
SELECT ok(cron_schedule_max_gap('not a schedule') IS NULL,        'T11: an unknown schedule gives NULL, not a guess');

SET LOCAL ROLE anon;
SELECT ok(
  (SELECT overdue = false FROM cron_job_health() WHERE jobname = 'check-season-reset'),
  'T12: a daily job that ran just now is not overdue');
RESET ROLE;

-- The scheduler stops: no new runs, so nothing fails — the last run simply
-- falls three days behind a daily schedule.
UPDATE cron.job_run_details
   SET start_time = start_time - INTERVAL '3 days', end_time = end_time - INTERVAL '3 days'
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'check-season-reset');

SET LOCAL ROLE anon;
SELECT ok(
  (SELECT overdue AND expected_every = '1 day' AND failures_since_success = 0
     FROM cron_job_health() WHERE jobname = 'check-season-reset'),
  'T13: with no run for 3 days on a daily schedule it is overdue, though nothing failed');
RESET ROLE;

SELECT ok(
  NOT has_function_privilege('anon', 'cron_schedule_max_gap(text)', 'EXECUTE'),
  'T14: the helper is not exposed to anon');

SELECT * FROM finish();
ROLLBACK;
