-- ============================================================
-- Arena: a client submission may be scored below its declared fidelity
-- (T-100; follows playground #471)
--
-- Since #471 the CLI discounts by the tier a gene earned on this run, not the
-- one it declares: a declared Native that did not run in the sandbox (no
-- gene.ir.wasm, or no sandbox on the platform) is scored as Wrapped, ×0.70.
-- guard_arena_entry_client_write (20261021200000, T-58) accepted only the
-- declared tier's discount, so that honest score was refused and the CLI
-- stopped sending it. The old ×1.00 it used to send was the false claim.
--
-- Now:
--   - the declared tier's discount, or a lower tier's, is accepted;
--   - a higher tier's is refused, and the error says so;
--   - a discount that is no §5.1 tier's is refused;
--   - the tier a score was written at is recorded in the new column
--     arena_entries.effective_fidelity, by the guard, read off the discount
--     (§5.1 maps tiers to discounts one-to-one). Clients cannot write it: no
--     column privilege, and the guard overwrites it on a client write;
--   - anon is refused by the guard itself, not only by missing privileges.
--
-- Clients before 0.31.0 send the declared tier's discount, as they always
-- have: accepted, recorded as the declared tier. No client sends
-- effective_fidelity.
--
-- Not changed: what ranks (fitness_value, already base × the discount sent),
-- what feeds reputation (measured rows only, and client rows are filed as
-- estimated — arena_entry_is_measured), the leaderboard RPCs' return types
-- (they keep showing the gene's declared fidelity next to the row's
-- fidelity_discount; exposing effective_fidelity there is a new function
-- version, not this migration), arena_invalidation_verdict (a published
-- Native without an artifact is still invalidated, whatever tier its score
-- was submitted at).
--
-- Additive per ADR-295: one new nullable column with a CHECK, the guard
-- replaced with the same signature. Rows written before this keep
-- effective_fidelity NULL ("not recorded").
-- Security: changes who may write which discount (spec-gate L2 in the PR).
-- ============================================================

ALTER TABLE arena_entries
  ADD COLUMN IF NOT EXISTS effective_fidelity TEXT DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_effective_fidelity') THEN
    ALTER TABLE arena_entries
      ADD CONSTRAINT chk_arena_effective_fidelity
      CHECK (effective_fidelity IS NULL OR effective_fidelity IN ('Native', 'Hybrid', 'Wrapped'));
  END IF;
END $$;

COMMENT ON COLUMN arena_entries.effective_fidelity IS
  'The spec §5.1 tier this score was discounted at, recorded by guard_arena_entry_client_write from fidelity_discount (T-100). At or below genes.fidelity: lower when the submitting client found the gene did not run at its declared tier (a declared Native not run in the sandbox is Wrapped). NULL on rows written before 2026-10-27. Not client-writable.';

-- No column privilege for effective_fidelity: the GRANT INSERT/UPDATE lists in
-- 20261021200000 name the columns a client may send, and it is not one.

CREATE OR REPLACE FUNCTION guard_arena_entry_client_write()
RETURNS TRIGGER AS $$
DECLARE
  v_changed  TEXT[] := ARRAY[]::TEXT[];
  v_domain   TEXT;
  v_fidelity TEXT;
  v_discount DOUBLE PRECISION;
  v_tier     TEXT;
BEGIN
  -- Only client requests (PostgREST roles), and not server-side writers
  -- acting inside one (they set the marker).
  IF coalesce(auth.role(), '') NOT IN ('authenticated', 'anon')
     OR coalesce(current_setting('rotifer.arena_server_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Anonymous requests submit nothing. anon has no write privilege on this
  -- table either; saying it here as well means a later grant cannot open it
  -- (T-100).
  IF auth.role() = 'anon' THEN
    RAISE EXCEPTION
      'arena_entries: anon cannot submit to the Arena; sign in first'
      USING ERRCODE = '42501';
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
      IF v_discount IS NULL THEN
        RAISE EXCEPTION
          'arena_entries: fidelity_discount % does not match the gene''s fidelity % (spec §5.1: %)',
          NEW.fidelity_discount, v_fidelity, v_discount
          USING ERRCODE = '42501';
      END IF;
      -- The declared tier, or a lower one; never a higher one (T-100). The
      -- CLI discounts by the tier the gene earned on this run: a declared
      -- Native that did not run in the sandbox is scored as Wrapped
      -- (playground #471, src/utils/fidelity-discount.ts effectiveFidelity).
      -- §5.1's discounts map one-to-one onto tiers, so the tier is read off
      -- the discount and recorded here, by the server. The client does not
      -- name it: a second claim would be one more thing to check, and a
      -- column a re-submission does not send would go stale.
      v_tier := CASE
        WHEN abs(NEW.fidelity_discount - 1.00) <= 1e-9 THEN 'Native'
        WHEN abs(NEW.fidelity_discount - 0.85) <= 1e-9 THEN 'Hybrid'
        WHEN abs(NEW.fidelity_discount - 0.70) <= 1e-9 THEN 'Wrapped'
      END;
      IF v_tier IS NULL THEN
        RAISE EXCEPTION
          'arena_entries: fidelity_discount % is not a spec §5.1 discount (Native 1.00, Hybrid 0.85, Wrapped 0.70)',
          NEW.fidelity_discount
          USING ERRCODE = '42501';
      END IF;
      IF NEW.fidelity_discount > v_discount + 1e-9 THEN
        RAISE EXCEPTION
          'arena_entries: fidelity_discount % is the % tier, above the gene''s declared fidelity % (spec §5.1: % or lower)',
          NEW.fidelity_discount, v_tier, v_fidelity, v_discount
          USING ERRCODE = '42501';
      END IF;
      NEW.effective_fidelity := v_tier;
      -- fitness_value = base_fitness × fidelity_discount, or the recorded
      -- pair reconstructs nothing.
      IF NEW.base_fitness IS NOT NULL AND NEW.fitness_value IS NOT NULL
         AND abs(NEW.fitness_value - NEW.base_fitness * NEW.fidelity_discount) > 1e-9 THEN
        RAISE EXCEPTION
          'arena_entries: fitness_value % is not base_fitness × fidelity_discount (%)',
          NEW.fitness_value, NEW.base_fitness * NEW.fidelity_discount
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      -- Not a score write: the recorded tier stays what the score was
      -- written at, whatever the request carried for it.
      NEW.effective_fidelity := OLD.effective_fidelity;
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
  'T-58: what a client (authenticated, no rotifer.arena_server_write marker) may write to arena_entries. Refuses anon (T-100). Records a client-claimed sandbox as estimated (ADR-319 D3 changed, approved 2026-10-21). Refuses changes to id, gene_id, created_at, total_calls and the invalidation pair; any change to a binding_runtime row; unknown-legacy; a domain other than the gene''s; a missing base_fitness / fidelity_discount; a fidelity_discount that is no spec §5.1 tier''s or is above the gene''s declared tier (a lower tier is accepted, T-100), and a fitness_value that is not base × discount. Records the tier the discount was taken at in effective_fidelity. Sets total_calls and created_at on insert.';
