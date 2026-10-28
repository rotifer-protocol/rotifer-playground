-- ============================================================
-- arena_entries.formula_version: which F(g) formula produced the score
-- (ADR-346 D5, T-107)
-- ============================================================
--
-- The same inputs have produced three different F(g) scales in two months:
-- additive (version 1), multiplicative in (0, 2·ln 2] (version 2, ADR-318 D2,
-- CLI 0.25.0) and multiplicative normalized to [0, 1] (version 3, ADR-346).
-- Nothing in arena_entries said which one a row used, so telling them apart
-- meant guessing from dates — and old and new CLIs upload side by side.
--
-- Additive only (ADR-295): a nullable column, NULL on every row written
-- before it existed. rotifer-core numbers its versions the same way
-- (fitness::FORMULA_VERSION).
--
-- Who sets it. The label has to describe the write that put the score there.
-- A column the client sends in the row would not: the CLI upserts
-- (on_conflict=gene_id, merge-duplicates), which sets only the columns it
-- sends, so an older CLI re-submitting a gene a newer one had labelled 3
-- would leave 3 on an old-scale score. So the client does not write the
-- column at all (no GRANT). guard_arena_entry_client_write, replaced below
-- with every rule of 20261027100000 unchanged, sets it on each client write
-- from the x-rotifer-formula-version request header, and clears it when the
-- header is missing or is not a version. Server-side writers (the binding,
-- season jobs) are let through by the guard as before and set it themselves
-- if they need to.
--
-- The CHECK only refuses what cannot be a version (0, negative); it does not
-- list the known ones, so a CLI shipping version 4 is not refused until a
-- migration catches up.
--
-- Order on production: after 20261027100000 (T-100), whose guard this
-- replaces. 20260901050000 stays unapplied, as before; this migration does
-- not depend on it.

ALTER TABLE arena_entries ADD COLUMN IF NOT EXISTS formula_version smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_arena_formula_version'
       AND conrelid = 'public.arena_entries'::regclass
  ) THEN
    ALTER TABLE arena_entries
      ADD CONSTRAINT chk_arena_formula_version CHECK (formula_version IS NULL OR formula_version >= 1);
  END IF;
END;
$$;

COMMENT ON COLUMN arena_entries.formula_version IS
  'Which F(g) formula produced fitness_value: 1 additive, 2 multiplicative in (0, 2·ln 2] (ADR-318 D2), 3 multiplicative normalized to [0, 1] (ADR-346). Set by guard_arena_entry_client_write on every client write from the x-rotifer-formula-version request header; NULL when the writer did not send one, and on rows written before 2026-10-27.';

CREATE OR REPLACE FUNCTION guard_arena_entry_client_write()
RETURNS TRIGGER AS $$
DECLARE
  v_changed  TEXT[] := ARRAY[]::TEXT[];
  v_domain   TEXT;
  v_fidelity TEXT;
  v_discount DOUBLE PRECISION;
  v_tier     TEXT;
  v_version  TEXT;
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

  -- Which formula scored this write: the version the writing client names in
  -- its x-rotifer-formula-version request header (PostgREST passes request
  -- headers as request.headers, names lowercased), recorded here on every
  -- client write. No header, or one that is not a whole number from 1, means
  -- the writer did not say, and the column is cleared: an older CLI
  -- re-submitting a row a newer one labelled must not leave the newer label
  -- on its old-scale score. The client cannot write the column itself (it is
  -- not in its GRANT list), so a value in the row is never taken.
  v_version := nullif(current_setting('request.headers', true), '')::json ->> 'x-rotifer-formula-version';
  NEW.formula_version := CASE
    WHEN v_version ~ '^[1-9][0-9]{0,3}$' THEN v_version::smallint
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;
