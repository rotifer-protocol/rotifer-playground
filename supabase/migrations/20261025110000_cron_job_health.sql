-- ============================================================
-- cron_job_health(): whether each pg_cron job is succeeding and still
-- running on schedule (T-82)
--
-- check-season-reset failed every night from 2026-08-17 to 2026-10-24 — 68
-- runs — and nobody knew: pg_cron records failures in cron.job_run_details,
-- which nothing reads. The scheduled workflow .github/workflows/
-- pg-cron-health.yml calls this function once a day and keeps one GitHub
-- issue open while any job is failing or overdue.
--
-- What it returns, per job: name, schedule, whether it is active, when it
-- last ran and with what status, when it last succeeded, how many runs have
-- failed since then, the longest gap the schedule allows between two runs,
-- and whether the job is overdue — no run for more than two of those gaps,
-- which is what a stopped scheduler looks like: no failures, no rows at all.
-- What it does not return: the command text and return_message (error text
-- can carry internals), database and username.
--
-- Callable by anon so the workflow can use the publishable key the CLI
-- already ships (src/cloud/types.ts) — no new secret in GitHub Actions. What
-- that makes public is the list of job names and schedules and whether they
-- are failing or overdue; no data, no SQL, no error detail.
--
-- Additive per ADR-295: two functions.
-- ============================================================

-- The longest time a schedule can leave between two runs — an upper bound,
-- so that "overdue" never fires on a job that is merely between runs.
-- Understands pg_cron's '<n> seconds' form, the @hourly/@daily/... macros and
-- five-field cron; anything else returns NULL, which cron_job_health() reports
-- as overdue = NULL (cannot judge) rather than guessing.
CREATE OR REPLACE FUNCTION cron_schedule_max_gap(p_schedule TEXT)
RETURNS INTERVAL
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_schedule TEXT := lower(btrim(p_schedule));
  v_fields   TEXT[];
  v_step     TEXT;
BEGIN
  IF v_schedule IS NULL OR v_schedule = '' THEN
    RETURN NULL;
  END IF;

  v_step := substring(v_schedule FROM '^([0-9]+) +seconds?$');
  IF v_step IS NOT NULL THEN
    RETURN make_interval(secs => v_step::INTEGER);
  END IF;

  CASE v_schedule
    WHEN '@hourly'              THEN RETURN INTERVAL '1 hour';
    WHEN '@daily', '@midnight'  THEN RETURN INTERVAL '1 day';
    WHEN '@weekly'              THEN RETURN INTERVAL '7 days';
    WHEN '@monthly'             THEN RETURN INTERVAL '31 days';
    WHEN '@yearly', '@annually' THEN RETURN INTERVAL '366 days';
    ELSE NULL;
  END CASE;

  v_fields := regexp_split_to_array(v_schedule, '\s+');
  IF array_length(v_fields, 1) <> 5 THEN
    RETURN NULL;
  END IF;

  -- minute hour day-of-month month day-of-week: the coarsest restricted
  -- field bounds the gap.
  IF v_fields[4] <> '*' THEN RETURN INTERVAL '366 days'; END IF;
  IF v_fields[3] <> '*' THEN RETURN INTERVAL '31 days';  END IF;
  IF v_fields[5] <> '*' THEN RETURN INTERVAL '7 days';   END IF;

  IF v_fields[2] <> '*' THEN
    v_step := substring(v_fields[2] FROM '^\*/([0-9]+)$');
    RETURN CASE WHEN v_step IS NOT NULL
                THEN make_interval(hours => v_step::INTEGER)
                ELSE INTERVAL '1 day' END;
  END IF;

  IF v_fields[1] = '*' THEN RETURN INTERVAL '1 minute'; END IF;
  v_step := substring(v_fields[1] FROM '^\*/([0-9]+)$');
  RETURN CASE WHEN v_step IS NOT NULL
              THEN make_interval(mins => v_step::INTEGER)
              ELSE INTERVAL '1 hour' END;
END;
$$;

COMMENT ON FUNCTION cron_schedule_max_gap(TEXT) IS
  'T-82: upper bound on the gap between two runs of a pg_cron schedule (seconds form, @macros, five-field cron); NULL when the schedule is not understood. Used by cron_job_health() for overdue.';

REVOKE ALL ON FUNCTION cron_schedule_max_gap(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION cron_schedule_max_gap(TEXT) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION cron_job_health()
RETURNS TABLE (
  jobname                 TEXT,
  schedule                TEXT,
  active                  BOOLEAN,
  last_run_at             TIMESTAMPTZ,
  last_status             TEXT,
  last_succeeded_at       TIMESTAMPTZ,
  failures_since_success  INTEGER,
  expected_every          TEXT,
  overdue                 BOOLEAN
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
        AND f.start_time > COALESCE(ok.last_ok, '-infinity'::timestamptz)),
    gap.max_gap::text,
    -- More than two allowed gaps without a run. NULL when it cannot be judged:
    -- the schedule is not understood, or the job has no recorded run.
    CASE
      WHEN NOT j.active THEN false
      WHEN gap.max_gap IS NULL OR last_run.start_time IS NULL THEN NULL
      ELSE last_run.start_time < now() - 2 * gap.max_gap
    END
  FROM cron.job j
  CROSS JOIN LATERAL (SELECT public.cron_schedule_max_gap(j.schedule::text) AS max_gap) gap
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
  'T-82: per pg_cron job — name, schedule, active, last run time and status, last success, failures since then, the longest gap its schedule allows, and overdue (no run for more than two such gaps). No command text or error messages. Read daily by .github/workflows/pg-cron-health.yml, which keeps an issue open while any job fails or is overdue.';

REVOKE ALL ON FUNCTION cron_job_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cron_job_health() TO anon, authenticated, service_role;
