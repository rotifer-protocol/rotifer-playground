-- ============================================================
-- cron_job_health(): whether each pg_cron job is succeeding (T-82)
--
-- check-season-reset failed every night from 2026-08-17 to 2026-10-24 — 68
-- runs — and nobody knew: pg_cron records failures in cron.job_run_details,
-- which nothing reads. The scheduled workflow .github/workflows/
-- pg-cron-health.yml calls this function once a day and keeps one GitHub
-- issue open while any job is failing.
--
-- What it returns, per job: name, schedule, whether it is active, when it
-- last ran and with what status, when it last succeeded, and how many runs
-- have failed since then. What it does not return: the command text and
-- return_message (error text can carry internals), database and username.
--
-- Callable by anon so the workflow can use the publishable key the CLI
-- already ships (src/cloud/types.ts) — no new secret in GitHub Actions. What
-- that makes public is the list of job names and schedules and whether they
-- are failing; no data, no SQL, no error detail.
--
-- Additive per ADR-295: one function.
-- ============================================================

CREATE OR REPLACE FUNCTION cron_job_health()
RETURNS TABLE (
  jobname                 TEXT,
  schedule                TEXT,
  active                  BOOLEAN,
  last_run_at             TIMESTAMPTZ,
  last_status             TEXT,
  last_succeeded_at       TIMESTAMPTZ,
  failures_since_success  INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    j.jobname::text,
    j.schedule::text,
    j.active,
    last_run.start_time,
    last_run.status::text,
    ok.last_ok,
    (SELECT count(*)::integer
       FROM cron.job_run_details f
      WHERE f.jobid = j.jobid
        AND f.status = 'failed'
        AND f.start_time > COALESCE(ok.last_ok, '-infinity'::timestamptz))
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT d.start_time, d.status
      FROM cron.job_run_details d
     WHERE d.jobid = j.jobid
     ORDER BY d.start_time DESC NULLS LAST
     LIMIT 1
  ) last_run ON true
  LEFT JOIN LATERAL (
    SELECT max(d.start_time) AS last_ok
      FROM cron.job_run_details d
     WHERE d.jobid = j.jobid AND d.status = 'succeeded'
  ) ok ON true
  ORDER BY j.jobname
$$;

COMMENT ON FUNCTION cron_job_health() IS
  'T-82: per pg_cron job — name, schedule, active, last run time and status, last success, failures since then. No command text or error messages. Read daily by .github/workflows/pg-cron-health.yml, which keeps an issue open while any job fails.';

REVOKE ALL ON FUNCTION cron_job_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cron_job_health() TO anon, authenticated, service_role;
