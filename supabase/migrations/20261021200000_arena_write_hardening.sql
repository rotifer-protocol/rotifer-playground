-- ============================================================
-- Arena write hardening: what a client may write to arena_entries and
-- arena_evaluation_runs (T-58; audit .agent-team/drafts/T-58-arena-rls-audit.md
-- §4.2 items 1–5, findings F1, F4 (discount only), F6–F10)
--
-- Both tables are written by clients straight through PostgREST with the
-- author's JWT (CLI src/cloud/client.ts arenaSubmit / publishEvaluationRuns),
-- so RLS "owns the gene" was the only rule, and it let an author:
--   - clear an invalidation on their own row, or invent one (F1);
--   - move a row to another of their genes, change its domain, id,
--     created_at or total_calls (F6);
--   - overwrite a binding_runtime measurement with a self-report (F4);
--   - claim Native's discount (1.00) for a Wrapped gene, or send no
--     discount at all and record the score undiscounted (F4, A6);
--   - write evaluation runs for anyone's gene, with any evaluated_at (F7, F8).
-- And server-side writers that clients can reach (log_mcp_call → the
-- total_calls trigger; apply_arena_invalidation) ran the client branch of the
-- guards, because SECURITY DEFINER changes the SQL identity but not the JWT:
-- auth.role() still says authenticated. That rewrote the victim row's
-- evaluator to the caller, and aborted on binding_runtime rows (F5, F9).
--
-- Two layers, as arena_evaluation_runs already had for UPDATE/DELETE:
--   1. Triggers decide what a value must be (they can compare with genes and
--      with the old row, which a privilege cannot).
--   2. Column privileges are the second line: if a guard is ever dropped by a
--      later migration, the columns a client has no business touching stay
--      out of reach. Table-level privileges are revoked first, because a
--      table-level grant makes any column-level revoke a no-op.
--
-- Server-side writers mark their writes with a transaction-local setting,
-- rotifer.arena_server_write = 'on' (the pattern unpublish_via_audited_rpc
-- uses with rotifer.visibility_change). Clients cannot set it: set_config is
-- in pg_catalog, which PostgREST does not expose, and a PostgREST request is
-- a single statement. The writers reset it before returning.
--
-- What the current CLI sends is unaffected: arena_entries gets the 14 granted
-- columns (unchanged values for gene_id/domain on a re-submission), and runs
-- get the 8 granted columns. Verified against a local stack with real
-- PostgREST (tests/e2e/arena-submit-upsert.test.ts).
--
-- Not here (separate tasks): caller spoofing for unique_callers (F2), cascade
-- deletes through genes (F3), total_calls inflation via log_mcp_call (F5 —
-- only the evaluator rewrite and the binding_runtime abort are fixed here),
-- and the NULL hole in the reference-scale CHECK (F12).
--
-- Changes ADR-319 D3's trust model (approved by the user 2026-10-21): a
-- client-claimed evaluation_method 'sandbox' is recorded as 'estimated'
-- (F4). binding_runtime keeps its rule (only the binding writes it).
--
-- Changes an RLS policy: arena_evaluation_runs' INSERT policy is replaced
-- (DROP + CREATE). Security review: the T-58 audit above.
-- Additive otherwise per ADR-295: new functions and triggers; existing
-- functions are replaced with the same signature and the same behaviour plus
-- the server-write marker. No column, constraint or row is changed.
-- ============================================================

-- ── arena_entries: what a client write must look like ────────

CREATE OR REPLACE FUNCTION guard_arena_entry_client_write()
RETURNS TRIGGER AS $$
DECLARE
  v_changed  TEXT[] := ARRAY[]::TEXT[];
  v_domain   TEXT;
  v_fidelity TEXT;
  v_discount DOUBLE PRECISION;
BEGIN
  -- Only client requests (PostgREST roles), and not server-side writers
  -- acting inside one (they set the marker).
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon')
     OR coalesce(current_setting('rotifer.arena_server_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- A binding_runtime row is the binding's measurement. A client may not
    -- edit it at all, including turning it into a self-report.
    IF OLD.evaluation_method = 'binding_runtime' THEN
      RAISE EXCEPTION
        'arena_entries: a binding_runtime row is written by the binding only (ADR-319 D2)'
        USING ERRCODE = '42501';
    END IF;

    -- Identity, the counter and the invalidation belong to the server.
    IF NEW.id IS DISTINCT FROM OLD.id THEN v_changed := array_append(v_changed, 'id'); END IF;
    IF NEW.gene_id IS DISTINCT FROM OLD.gene_id THEN v_changed := array_append(v_changed, 'gene_id'); END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN v_changed := array_append(v_changed, 'created_at'); END IF;
    IF NEW.total_calls IS DISTINCT FROM OLD.total_calls THEN v_changed := array_append(v_changed, 'total_calls'); END IF;
    IF NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN v_changed := array_append(v_changed, 'invalidated_at'); END IF;
    IF NEW.invalidation_reason IS DISTINCT FROM OLD.invalidation_reason THEN v_changed := array_append(v_changed, 'invalidation_reason'); END IF;
    IF cardinality(v_changed) > 0 THEN
      RAISE EXCEPTION
        'arena_entries: % cannot be changed by a client', array_to_string(v_changed, ', ')
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- An invalidation is set by apply_arena_invalidation from a reproducible
    -- criterion (ADR-319 D6), never brought along by the submitter.
    IF NEW.invalidated_at IS NOT NULL OR NEW.invalidation_reason IS NOT NULL THEN
      RAISE EXCEPTION
        'arena_entries: invalidated_at / invalidation_reason are set by the server, not submitted'
        USING ERRCODE = '42501';
    END IF;
    NEW.total_calls := 0;
    NEW.created_at := now();
  END IF;

  -- unknown-legacy marks rows that predate provenance; only the backfill
  -- writes it. (On INSERT it is also the column default, so a client that
  -- omits evaluation_method is refused too: the current CLI always sends it.)
  IF NEW.evaluation_method = 'unknown-legacy'
     AND (TG_OP = 'INSERT' OR OLD.evaluation_method IS DISTINCT FROM NEW.evaluation_method) THEN
    RAISE EXCEPTION
      'arena_entries: evaluation_method unknown-legacy is written by the backfill only; send estimated or declared'
      USING ERRCODE = '42501';
  END IF;

  -- F4: a client cannot claim 'sandbox'. Nothing on this path can tell a
  -- sandbox measurement from a number someone typed, and the current CLI
  -- never sends it (arena-submit.ts submits 'estimated'), so a client
  -- 'sandbox' is recorded as what it is: an estimate. Silently, so an older
  -- client is ranked lower rather than broken. This changes ADR-319 D3's
  -- trust model (sandbox was accepted as a client claim); approved by the
  -- user 2026-10-21. A sandbox tier comes back when the binding attests it
  -- (binding_runtime).
  IF NEW.evaluation_method = 'sandbox' THEN
    NEW.evaluation_method := 'estimated';
  END IF;

  SELECT g.domain, g.fidelity INTO v_domain, v_fidelity FROM genes g WHERE g.id = NEW.gene_id;
  IF FOUND THEN
    -- The domain decides which board a row is on; it is the gene's.
    IF (TG_OP = 'INSERT' OR NEW.domain IS DISTINCT FROM OLD.domain)
       AND NEW.domain IS DISTINCT FROM v_domain THEN
      RAISE EXCEPTION
        'arena_entries: domain must be the gene''s domain (%)', v_domain
        USING ERRCODE = '42501';
    END IF;

    -- Checked when the score is written, not on every later write: a season
    -- reset scales fitness_value server-side, and an unrelated client
    -- update must not be refused for that.
    IF NEW.fidelity_discount IS NOT NULL
       AND (TG_OP = 'INSERT'
            OR NEW.fitness_value IS DISTINCT FROM OLD.fitness_value
            OR NEW.base_fitness IS DISTINCT FROM OLD.base_fitness
            OR NEW.fidelity_discount IS DISTINCT FROM OLD.fidelity_discount) THEN
      -- FIDELITY_DISCOUNT, spec §5.1 v2.11 (native 1.00 / hybrid 0.85 /
      -- wrapped 0.70); the same table as src/types/phenotype.ts. It is a
      -- PAP-adjustable protocol parameter (§14.6): when it moves, this list
      -- moves with it in a new migration.
      v_discount := CASE v_fidelity
        WHEN 'Native'  THEN 1.00
        WHEN 'Hybrid'  THEN 0.85
        WHEN 'Wrapped' THEN 0.70
      END;
      IF v_discount IS NULL OR abs(NEW.fidelity_discount - v_discount) > 1e-9 THEN
        RAISE EXCEPTION
          'arena_entries: fidelity_discount % does not match the gene''s fidelity % (spec §5.1: %)',
          NEW.fidelity_discount, v_fidelity, v_discount
          USING ERRCODE = '42501';
      END IF;
      -- fitness_value = base_fitness × fidelity_discount, or the recorded
      -- pair reconstructs nothing.
      IF NEW.base_fitness IS NOT NULL AND NEW.fitness_value IS NOT NULL
         AND abs(NEW.fitness_value - NEW.base_fitness * NEW.fidelity_discount) > 1e-9 THEN
        RAISE EXCEPTION
          'arena_entries: fitness_value % is not base_fitness × fidelity_discount (%)',
          NEW.fitness_value, NEW.base_fitness * NEW.fidelity_discount
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- The pair is what the discount check above needs. Without this a client
  -- could leave both out (chk_arena_dual_column_pair allows "neither") and a
  -- Wrapped gene's score went in undiscounted (T-58 acceptance A6). The
  -- current CLI always sends both; rows written before them are left as
  -- they are until their next submission.
  IF NEW.base_fitness IS NULL OR NEW.fidelity_discount IS NULL THEN
    RAISE EXCEPTION
      'arena_entries: a client submission carries base_fitness and fidelity_discount (spec §5.1 dual column)'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_arena_entry_client_write() IS
  'T-58: what a client (authenticated/anon, no rotifer.arena_server_write marker) may write to arena_entries. Records a client-claimed sandbox as estimated (ADR-319 D3 changed, approved 2026-10-21). Refuses changes to id, gene_id, created_at, total_calls and the invalidation pair; any change to a binding_runtime row; unknown-legacy; a domain other than the gene''s; a missing base_fitness / fidelity_discount; a fidelity_discount other than spec §5.1''s for the gene''s fidelity, and a fitness_value that is not base × discount. Sets total_calls and created_at on insert.';

-- Sorts after trg_enforce_arena_provenance and before
-- trg_guard_arena_last_evaluated; BEFORE triggers fire in name order.
DROP TRIGGER IF EXISTS trg_guard_arena_entry_client_write ON arena_entries;
CREATE TRIGGER trg_guard_arena_entry_client_write
  BEFORE INSERT OR UPDATE ON arena_entries
  FOR EACH ROW EXECUTE FUNCTION guard_arena_entry_client_write();

REVOKE ALL ON FUNCTION guard_arena_entry_client_write() FROM PUBLIC, anon, authenticated;

-- The provenance guard, unchanged except that a marked server-side write is
-- not a client write: it keeps the row's evaluator and may touch a
-- binding_runtime row (F5, F9).
CREATE OR REPLACE FUNCTION enforce_arena_provenance()
RETURNS TRIGGER AS $$
DECLARE
  v_role TEXT := coalesce(auth.role(), '');
  v_uid  UUID := auth.uid();
BEGIN
  IF v_role IN ('authenticated', 'anon')
     AND coalesce(current_setting('rotifer.arena_server_write', true), '') <> 'on' THEN
    IF NEW.evaluation_method = 'binding_runtime' THEN
      RAISE EXCEPTION
        'evaluation_method=binding_runtime is attested by the binding, not chosen by clients (ADR-319 D2)'
        USING ERRCODE = '42501';
    END IF;

    IF v_uid IS NOT NULL THEN
      NEW.evaluator := v_uid::TEXT;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION enforce_arena_provenance() IS
  'ADR-319 D2: refuses binding_runtime from client roles and stamps evaluator from the authenticated principal. Server-side writers that set rotifer.arena_server_write are not client writes (T-58). Cannot distinguish sandbox/estimated/declared — those stay client claims, checkable only by §9.7.1 recomputation.';

-- ── arena_entries: column privileges (second line) ───────────

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON arena_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON arena_entries TO anon, authenticated;
-- The submission: what arenaSubmit sends (client.ts). An upsert needs UPDATE
-- on every column it sends, gene_id and domain included; the guard keeps them
-- from changing.
GRANT INSERT (gene_id, domain, fitness_value, safety_score, success_rate, latency_score,
              resource_efficiency, evaluation_method, evaluation_n, base_fitness,
              fidelity_discount, fitness_reference, l_ref_ms, cost_ref)
  ON arena_entries TO authenticated;
GRANT UPDATE (gene_id, domain, fitness_value, safety_score, success_rate, latency_score,
              resource_efficiency, evaluation_method, evaluation_n, base_fitness,
              fidelity_discount, fitness_reference, l_ref_ms, cost_ref)
  ON arena_entries TO authenticated;

-- ── Server-side writers mark their writes ────────────────────

CREATE OR REPLACE FUNCTION public.update_arena_total_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF NEW.gene_id IS NOT NULL
     AND NEW.gene_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    -- A counter bump is not the caller's submission: it must not stamp the
    -- caller as the row's evaluator, nor trip the guards on a binding_runtime
    -- row (T-58 F5).
    PERFORM set_config('rotifer.arena_server_write', 'on', true);
    UPDATE arena_entries
    SET total_calls = total_calls + 1
    WHERE gene_id = NEW.gene_id::uuid;
    PERFORM set_config('rotifer.arena_server_write', '', true);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.update_arena_total_calls() IS
  'mcp_call_log AFTER INSERT: increments arena_entries.total_calls when gene_id is a uuid; '
  'ignores NULL and non-uuid values (older clients sent directory names). '
  'Fixed 2026-08-15: previously compared uuid = text without a cast and aborted every gene-tagged insert. '
  'T-58: marks the write as server-side (rotifer.arena_server_write), so the caller is not stamped as evaluator.';

CREATE OR REPLACE FUNCTION apply_arena_invalidation()
RETURNS TABLE (invalidated INTEGER, released INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_inv INTEGER;
  v_rel INTEGER;
BEGIN
  -- Applying a criterion is not anyone's submission (T-58 F9).
  PERFORM set_config('rotifer.arena_server_write', 'on', true);

  WITH v AS (
    SELECT a.gene_id, arena_invalidation_verdict(a.gene_id) AS reason
      FROM arena_entries a
  ),
  ins AS (
    UPDATE arena_entries a
       SET invalidated_at = now(), invalidation_reason = v.reason
      FROM v
     WHERE v.gene_id = a.gene_id
       AND v.reason IS NOT NULL
       AND a.invalidated_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inv FROM ins;

  WITH v AS (
    SELECT a.gene_id, arena_invalidation_verdict(a.gene_id) AS reason
      FROM arena_entries a
  ),
  del AS (
    UPDATE arena_entries a
       SET invalidated_at = NULL, invalidation_reason = NULL
      FROM v
     WHERE v.gene_id = a.gene_id
       AND v.reason IS NULL
       AND a.invalidated_at IS NOT NULL
       AND a.invalidation_reason = ANY (arena_invalidation_reasons())
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_rel FROM del;

  PERFORM set_config('rotifer.arena_server_write', '', true);
  RETURN QUERY SELECT v_inv, v_rel;
END;
$$;

COMMENT ON FUNCTION apply_arena_invalidation() IS
  'ADR-319 D2 / plan 2.5: applies arena_invalidation_verdict to every row. Idempotent; clears only invalidations whose reason this job owns (arena_invalidation_reasons). Server-side only (T-58): service_role and the daily apply-arena-invalidation cron job.';

-- Anyone could run it, and with a client JWT it stamped the caller on every
-- row it touched (F9). It is the server's job.
REVOKE EXECUTE ON FUNCTION apply_arena_invalidation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_arena_invalidation() TO service_role;

-- It ran once, in its own migration, and never again (F13): a released or a
-- newly applicable invalidation waited for someone to run it by hand. Daily,
-- after the 01:00 season check. pg_cron is enabled by
-- 20260101000000_enable_pg_cron.sql; unschedule-then-schedule as
-- 20260517010000_v09_reset_season_impl.sql does.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'apply-arena-invalidation') THEN
    PERFORM cron.unschedule('apply-arena-invalidation');
  END IF;
  PERFORM cron.schedule(
    'apply-arena-invalidation',
    '30 1 * * *',
    $cmd$ SELECT * FROM apply_arena_invalidation(); $cmd$
  );
END;
$cron$;

-- ── arena_evaluation_runs: only the gene's owner records runs ─

-- Was WITH CHECK (true): any signed-in user could record runs for any gene
-- (F7, T-48 A1). Same ownership rule as arena_entries.
DROP POLICY IF EXISTS "Signed-in callers may record evaluation runs" ON arena_evaluation_runs;
DROP POLICY IF EXISTS "Gene owners may record evaluation runs" ON arena_evaluation_runs;
CREATE POLICY "Gene owners may record evaluation runs"
  ON arena_evaluation_runs FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (SELECT 1 FROM genes WHERE genes.id = gene_id AND genes.owner_id = auth.uid())
  );

-- A submission's runs number 0..SANDBOX_RUNS-1 (3 in arena-submit.ts). The
-- cap only has to keep one submission from flooding the ledger.
CREATE OR REPLACE FUNCTION guard_arena_evaluation_run_client_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon')
     OR coalesce(current_setting('rotifer.arena_server_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- When a run was recorded is the server's to say (F8).
  NEW.evaluated_at := now();

  IF NEW.run_index >= 100 THEN
    RAISE EXCEPTION
      'arena_evaluation_runs: run_index % is past the per-submission limit (100)', NEW.run_index
      USING ERRCODE = '42501';
  END IF;

  -- A submission belongs to one gene and one evaluator. Without this, anyone
  -- could append runs under someone else's submission_id (F7). The lock
  -- serializes concurrent inserts into the same submission.
  PERFORM pg_advisory_xact_lock(hashtext('arena_evaluation_runs:' || NEW.submission_id::TEXT));
  IF EXISTS (
    SELECT 1 FROM arena_evaluation_runs r
     WHERE r.submission_id = NEW.submission_id
       AND (r.gene_id <> NEW.gene_id OR r.evaluator IS DISTINCT FROM auth.uid()::TEXT)
  ) THEN
    RAISE EXCEPTION
      'arena_evaluation_runs: submission % belongs to another gene or evaluator', NEW.submission_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION guard_arena_evaluation_run_client_insert() IS
  'T-58: a client-recorded run gets the server''s evaluated_at, a run_index below 100, and may only join a submission_id whose runs are for the same gene and evaluator.';

DROP TRIGGER IF EXISTS trg_guard_arena_evaluation_run_client_insert ON arena_evaluation_runs;
CREATE TRIGGER trg_guard_arena_evaluation_run_client_insert
  BEFORE INSERT ON arena_evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION guard_arena_evaluation_run_client_insert();

REVOKE ALL ON FUNCTION guard_arena_evaluation_run_client_insert() FROM PUBLIC, anon, authenticated;

-- Column privileges: the 8 columns publishEvaluationRuns sends (client.ts).
-- UPDATE/DELETE/TRUNCATE and anon INSERT were revoked in 20260818170000.
REVOKE INSERT, REFERENCES, TRIGGER ON arena_evaluation_runs FROM PUBLIC, anon, authenticated;
GRANT INSERT (gene_id, submission_id, run_index, sandbox_success, output_schema_valid,
              latency_ms, resource_cost, failure_kind)
  ON arena_evaluation_runs TO authenticated;
