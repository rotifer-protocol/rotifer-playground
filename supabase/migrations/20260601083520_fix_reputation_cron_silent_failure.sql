-- Fix silent failure of the daily reputation cron (frozen since 2026-05-18).
--
-- Root cause chain:
--   compute_gene_reputation() ends with `UPDATE genes SET reputation_score=...`.
--   That UPDATE fires BEFORE-trigger trg_validate_content_hash, which (on any
--   UPDATE while published=true) runs the duplicate-content_hash check and
--   RAISE EXCEPTION 23505 when another published gene already has the hash. The
--   throw propagates up through compute_all_reputations()'s FOR loop into its
--   outer `EXCEPTION WHEN OTHERS`. Because the `INSERT ... RETURNING id INTO
--   v_log_id` for the 'gene' step lives in the SAME block, it is rolled back
--   together with the exception, so the handler's
--   `UPDATE reputation_compute_log WHERE id = v_log_id` matches 0 rows.
--   Net result: the whole batch rolls back, nothing is logged, and pg_cron
--   observes a normal return -> job_run_details shows 'succeeded' while
--   reputation_compute_log stays frozen and reputation scores go stale.
--
-- This migration is schema-only (CREATE OR REPLACE, signatures unchanged):
--   Fix 1 — guard validate_content_hash_on_publish(): skip validation on UPDATEs
--           that change neither content_hash, phenotype, nor published. The
--           internal reputation_score bump is exactly such an UPDATE, so it no
--           longer re-triggers the duplicate check. Genuine publish/content
--           changes (and all INSERTs) still validate as before.
--   Fix 2 — un-mask compute_all_reputations(): isolate each gene/developer
--           compute in its own BEGIN/EXCEPTION so one bad row is RAISE WARNING'd
--           and skipped instead of aborting + silently rolling back the whole
--           batch; the outer handler now RAISE WARNING's SQLERRM so any failure
--           reaches the Postgres log / pg_cron output.
--
-- Data note: this does NOT dedupe the existing duplicate-content_hash published
-- genes (that is a product decision — which copy to unpublish). The trigger
-- still prevents NEW duplicate publishes.

BEGIN;

-- ── Fix 1: guard the content-hash validation trigger ─────────────────────────
CREATE OR REPLACE FUNCTION public.validate_content_hash_on_publish()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_canonical TEXT;
  v_server_hash TEXT;
  v_existing_id UUID;
BEGIN
  -- Skip validation on UPDATEs that touch neither content nor publish state
  -- (e.g. the reputation_score / downloads bumps written by the reputation cron).
  -- Without this guard such UPDATEs re-run the duplicate-hash check and RAISE
  -- 23505, which silently aborts compute_all_reputations().
  IF TG_OP = 'UPDATE'
     AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
     AND NEW.phenotype    IS NOT DISTINCT FROM OLD.phenotype
     AND NEW.published    IS NOT DISTINCT FROM OLD.published
  THEN
    RETURN NEW;
  END IF;

  IF NEW.published = true AND NEW.content_hash IS NOT NULL AND NEW.phenotype IS NOT NULL THEN
    v_canonical := NEW.phenotype::jsonb::text;
    v_server_hash := encode(
      extensions.digest(v_canonical::bytea, 'sha256'::text),
      'hex'
    );
    IF v_server_hash <> NEW.content_hash THEN
      RAISE WARNING 'content_hash mismatch (non-blocking, see ADR-292): gene_id=% client=% server=%',
        NEW.id, NEW.content_hash, v_server_hash;
    END IF;
    SELECT id INTO v_existing_id
      FROM genes
      WHERE content_hash = NEW.content_hash
        AND id != NEW.id
        AND published = true
      LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate content_hash: gene % already has this hash. This gene is a duplicate.',
        v_existing_id
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── Fix 2: per-item isolation + visible errors in the reputation batch ────────
CREATE OR REPLACE FUNCTION public.compute_all_reputations()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gene RECORD;
  v_dev RECORD;
  v_log_id UUID;
  v_today DATE := CURRENT_DATE;
  v_gene_count INTEGER := 0;
  v_dev_count INTEGER := 0;
  v_cm_count INTEGER := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM reputation_compute_log
    WHERE compute_type = 'gene' AND status = 'success'
    AND started_at::DATE = v_today
  ) THEN
    RETURN;
  END IF;

  -- Step 0: Refresh ContributionMetrics (§23.1)
  -- ⚠️ Anti-manipulation rules NOT activated (v0.9 per D-01)
  INSERT INTO reputation_compute_log (compute_type, affected_count, status)
  VALUES ('contribution_metrics', 0, 'running') RETURNING id INTO v_log_id;

  v_cm_count := refresh_contribution_metrics();

  UPDATE reputation_compute_log
  SET affected_count = v_cm_count,
      finished_at = now(), status = 'success'
  WHERE id = v_log_id;

  -- Step 1: Gene reputations
  INSERT INTO reputation_compute_log (compute_type, affected_count, status)
  VALUES ('gene', 0, 'running') RETURNING id INTO v_log_id;

  FOR v_gene IN SELECT id FROM genes WHERE published = true LOOP
    -- Isolate each gene so one failure can't abort + silently roll back the
    -- whole batch (the bug that froze reputation_compute_log since 2026-05-18).
    BEGIN
      PERFORM compute_gene_reputation(v_gene.id);
      v_gene_count := v_gene_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'compute_gene_reputation failed for gene %: %', v_gene.id, SQLERRM;
    END;
  END LOOP;

  UPDATE reputation_compute_log
  SET affected_count = v_gene_count,
      finished_at = now(), status = 'success'
  WHERE id = v_log_id;

  -- Step 2: Developer reputations
  INSERT INTO reputation_compute_log (compute_type, affected_count, status)
  VALUES ('developer', 0, 'running') RETURNING id INTO v_log_id;

  FOR v_dev IN SELECT DISTINCT owner_id FROM genes WHERE published = true LOOP
    BEGIN
      PERFORM compute_developer_reputation(v_dev.owner_id);
      v_dev_count := v_dev_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'compute_developer_reputation failed for owner %: %', v_dev.owner_id, SQLERRM;
    END;
  END LOOP;

  UPDATE reputation_compute_log
  SET affected_count = v_dev_count,
      finished_at = now(), status = 'success'
  WHERE id = v_log_id;

EXCEPTION WHEN OTHERS THEN
  -- Surface the error instead of swallowing it. v_log_id may point to a row that
  -- was rolled back with the exception, so the UPDATE can match 0 rows; the
  -- RAISE WARNING guarantees the failure reaches the Postgres log / cron output.
  RAISE WARNING 'compute_all_reputations aborted: %', SQLERRM;
  UPDATE reputation_compute_log
  SET finished_at = now(), status = 'error', error_message = SQLERRM
  WHERE id = v_log_id;
END;
$function$;

COMMIT;
