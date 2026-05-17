-- ============================================================
-- v0.9 Stage 2 — reset_season(): replace stub with real implementation
-- Plan: protocol-v0.9-plan.md §3.2 (line 426-470 draft, fields corrected)
-- ADR-221 thermostat model · ADR-260 C3 carr deferred to v1.0
-- Predecessor commit (stub): rotifer-playground 624468a (2026-05-16)
-- ============================================================
--
-- Stage 1 shipped reset_season() as a stub raising NOT_IMPLEMENTED. This
-- migration replaces the body with the canonical logic from plan §3.2 and
-- uncomments the pg_cron 'check-season-reset' job that was deliberately
-- left commented out while the stub was still in place.
--
-- pgTAP assertions promoted from FAIL → PASS by this migration
-- (run via `supabase db test`):
--   B.2.1 — throws_like('%No active season found%')
--   B.2.2 — lives_ok happy path (insert archives + bump season number)
--   B.8.1 — check-season-reset cron job registered
--
-- Plan §3.2 draft corrections applied here:
--   1. arena_entries.score          → arena_entries.fitness_value
--      (the actual column name; plan draft was outdated)
--   2. arena_entries.wins / losses  → 0 / 0 placeholder
--      (those columns do not exist on arena_entries; pairwise battle stats
--       are deferred to v1.0 P2P arena per ADR-260)
--   3. arena_rank: ROW_NUMBER() OVER (ORDER BY reputation_score DESC)
--      → ROW_NUMBER() OVER (PARTITION BY g.domain ORDER BY fitness_value DESC, g.id)
--      (per-domain ranking matches arena_entries.idx_arena_fitness intent)
--   4. Added pg_try_advisory_lock for B.2.7 / B.9.1 concurrency contract.
--   5. Wrapped body in EXCEPTION block to release the lock on any error.

-- ------------------------------------------------------------
-- 1. reset_season() — full implementation (CREATE OR REPLACE the stub)
-- ------------------------------------------------------------

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
    -- B.2.1: locate the active season; raise if none.
    SELECT id, season_number, config
      INTO v_active_id, v_active_number, v_active_config
    FROM seasons
    WHERE status = 'active'
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
    UPDATE arena_entries
    SET fitness_value = fitness_value * v_retention;

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

-- Permissions unchanged from stub (re-applied for idempotency).
REVOKE EXECUTE ON FUNCTION reset_season() FROM anon;
REVOKE EXECUTE ON FUNCTION reset_season() FROM authenticated;
GRANT  EXECUTE ON FUNCTION reset_season() TO service_role;

-- ------------------------------------------------------------
-- 2. pg_cron registration — uncomment per stage-1 plan
-- ------------------------------------------------------------
--
-- B.8.1: stage 1 left this commented out to avoid auto-firing the stub.
-- Now reset_season() is real, schedule the daily season-end check.
--
-- Idempotency: cron.schedule(jobname, ...) is upsert-by-jobname in pg_cron
-- 1.x — but unschedule-then-schedule is the safer pattern across versions
-- and avoids any edge case if the schedule string changes later.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-season-reset') THEN
    PERFORM cron.unschedule('check-season-reset');
  END IF;

  PERFORM cron.schedule(
    'check-season-reset',
    '0 1 * * *',
    $cmd$
      UPDATE seasons SET status = 'ending'
      WHERE status = 'active'
        AND started_at + (config->>'duration_days')::INTEGER * INTERVAL '1 day' <= now();
      SELECT reset_season() WHERE EXISTS (SELECT 1 FROM seasons WHERE status = 'ending');
    $cmd$
  );
END;
$cron$;
