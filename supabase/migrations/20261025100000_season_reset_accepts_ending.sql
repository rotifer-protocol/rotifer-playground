-- ============================================================
-- reset_season() also takes a season the nightly job has marked 'ending'
-- (T-82)
--
-- The pg_cron job check-season-reset (20260517010000) runs, in one command:
--   UPDATE seasons SET status = 'ending'
--    WHERE status = 'active' AND <the season's duration has elapsed>;
--   SELECT reset_season() WHERE EXISTS (SELECT 1 FROM seasons WHERE status = 'ending');
-- reset_season() looked for status = 'active' only. The UPDATE had just moved
-- the season to 'ending', so it found nothing, raised 'No active season
-- found', and the whole command rolled back, UPDATE included. Season 1
-- (started 2026-05-18, 90 days) was due on 2026-08-16; from 2026-08-17 every
-- run failed (cron.job_run_details: 68 failed, 90 earlier runs succeeded with
-- nothing due), and season 1 is still active.
--
-- The fix is the one word in the lookup: the season to close is the open one,
-- whether it is still 'active' (a direct call, e.g. by an operator) or already
-- 'ending' (the nightly job). 'ending' is part of the designed lifecycle —
-- seasons_status_check allows ('active', 'ending', 'ended') — and nothing else
-- reads it. Everything else in the body is 20260517010000's, unchanged: the
-- advisory lock and its release on error, the fitness_retention_rate read
-- (default 0.5), the archive insert, the carryover, compute_all_reputations(),
-- opening the next season with the config carried forward. The error text
-- 'No active season found' is kept for the no-open-season case (seasons.sql
-- B.2.1 asserts it).
--
-- Not chosen: changing the cron command so it no longer pre-marks 'ending'.
-- That would mean unscheduling and rescheduling a pg_cron job from a migration
-- (the replay job has to emulate cron for that), it would leave 'ending' as a
-- state the schema allows but nothing ever enters, and it would not help a
-- season that is already 'ending' — this function would still refuse it.
--
-- Additive per ADR-295: CREATE OR REPLACE with the same signature; grants
-- re-applied as in 20260517040000.
-- ============================================================

CREATE OR REPLACE FUNCTION reset_season()
RETURNS INTEGER AS $$
DECLARE
  v_active_id      INTEGER;
  v_active_number  INTEGER;
  v_active_config  JSONB;
  v_retention      DOUBLE PRECISION;
  v_new_number     INTEGER;
  v_lock_key       BIGINT  := hashtext('reset_season');
  v_lock_acquired  BOOLEAN;
BEGIN
  -- B.2.7 / B.9.1: serialize concurrent reset_season() calls.
  v_lock_acquired := pg_try_advisory_lock(v_lock_key);
  IF NOT v_lock_acquired THEN
    RAISE EXCEPTION 'reset_season already in progress';
  END IF;

  BEGIN
    -- B.2.1: locate the open season — 'active', or 'ending' when the nightly
    -- check-season-reset job has just marked it (T-82); raise if none.
    SELECT id, season_number, config
      INTO v_active_id, v_active_number, v_active_config
    FROM seasons
    WHERE status IN ('active', 'ending')
    ORDER BY season_number DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No active season found';
    END IF;

    -- B.2.3: read fitness_retention_rate from the active config; default 0.5.
    v_retention := COALESCE(
      (v_active_config->>'fitness_retention_rate')::DOUBLE PRECISION,
      0.5
    );

    -- B.2.2 / B.2.4: archive every published Gene with current standings.
    --   final_fitness    = latest arena_entries.fitness_value (0 if missing)
    --   final_reputation = genes.reputation_score (0 if NULL)
    --   arena_rank       = per-domain ranking, NULLS-LAST on missing arena rows
    --   arena_wins/losses= 0 placeholder (deferred to v1.0 P2P arena)
    INSERT INTO season_archives (
      season_id, gene_id, final_fitness, final_reputation,
      arena_rank, arena_wins, arena_losses, domain
    )
    SELECT
      v_active_id,
      g.id,
      COALESCE(ae.fitness_value, 0)::DOUBLE PRECISION,
      COALESCE(g.reputation_score, 0)::DOUBLE PRECISION,
      ROW_NUMBER() OVER (
        PARTITION BY g.domain
        ORDER BY COALESCE(ae.fitness_value, 0) DESC, g.id
      )::INTEGER,
      0,
      0,
      g.domain
    FROM genes g
    LEFT JOIN arena_entries ae ON ae.gene_id = g.id
    WHERE g.published = true
    ON CONFLICT (season_id, gene_id) DO NOTHING;

    -- B.2.6: end the current season.
    UPDATE seasons
    SET status = 'ended', ended_at = now()
    WHERE id = v_active_id;

    -- F(g) half-life carryover into next season.
    -- Filter `fitness_value IS NOT NULL` keeps PostgREST's no-WHERE
    -- guard happy without altering behavior (NULL × scalar = NULL).
    UPDATE arena_entries
    SET fitness_value = fitness_value * v_retention
    WHERE fitness_value IS NOT NULL;

    -- B.2.5: trigger reputation recompute (idempotent per UTC day).
    PERFORM compute_all_reputations();

    -- Open the next season — config carries forward verbatim.
    v_new_number := v_active_number + 1;
    INSERT INTO seasons (season_number, status, config)
    VALUES (v_new_number, 'active', v_active_config);

    PERFORM pg_advisory_unlock(v_lock_key);
    RETURN v_new_number;

  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(v_lock_key);
    RAISE;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public';

COMMENT ON FUNCTION reset_season() IS
  'Ends the open season (status active, or ending when the check-season-reset cron job has just marked it), archives every published Gene''s standing, carries fitness over at fitness_retention_rate, recomputes reputations and opens the next season with the same config. service_role only.';

REVOKE EXECUTE ON FUNCTION reset_season() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reset_season() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION reset_season() TO service_role;
