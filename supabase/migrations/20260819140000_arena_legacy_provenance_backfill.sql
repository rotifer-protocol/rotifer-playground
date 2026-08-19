-- ============================================================
-- ADR-319 D2, plan 2.7: give the legacy rows the provenance they can prove
--
-- Every arena_entries row written before 20260818150000 landed as
-- 'unknown-legacy', because the column did not exist when it was written.
-- But the rows are not equally unknown. Four client paths wrote the board in
-- the 2026-02 → 2026-08 window, and three of them left a fingerprint in the
-- numbers themselves that can be checked by anyone reading the public table:
--
--   publish-default   The publish command used to write a fixed placeholder:
--                     fitness 0.5, safety 1, success 1, latency 0.8, resource
--                     0.8. Exactly that 5-tuple, nothing else.
--
--   hash-estimate     arena-submit without a sandbox derived every number from
--                     a seed: fitness = base + (seed % 250)/1000 with base
--                     0.70 (Native) or 0.45 (otherwise), success = 0.9 +
--                     (seed % 100)/1000, latency = 0.7 + ((seed>>8) % 300)/1000,
--                     resource = 0.6 + ((seed>>16) % 300)/1000. The seed came
--                     from a content hash the current schema no longer holds,
--                     so the value cannot be recomputed — but its shape can be
--                     checked: every dimension is an exact thousandth, each
--                     sits in the formula's range (JavaScript's `>>` on a
--                     32-bit seed can go negative, which is why latency reaches
--                     down to 0.4 and resource to 0.3), and fitness and success
--                     share a seed, so (fitness − base)·1000 and (success −
--                     0.9)·1000 agree modulo 50. A measured float fails the
--                     thousandth test immediately; a hand-typed number fails
--                     the congruence 49 times in 50.
--
--   sandbox           Real WASM execution under the pre-ADR-318 formula, which
--                     capped at exactly 1.0 with success exactly 1 and latency /
--                     resource as measured floats. The hash formula tops out at
--                     0.949, so 1.0 is unreachable by any other client path.
--
--   declared          The old MCP arena_submit accepted five numbers verbatim.
--                     What reached the board is round two-decimal values on
--                     every dimension — the shape of a person typing, not of
--                     any formula above.
--
-- The classifier is a view, public like the table, so the label on every row
-- can be re-derived by the reader rather than trusted. The backfill writes the
-- view's verdict onto rows that are still 'unknown-legacy' and nothing else —
-- a row that already carries real provenance is never touched, and re-running
-- the migration is a no-op.
--
-- What this does NOT change: ranking. estimated, declared and unknown-legacy
-- all sit outside the rankable set (ADR-319 D4), so moving rows among them
-- changes no standing. The six rows that become 'sandbox' are the ones the
-- async-express-artifact criterion already marks for invalidation — provenance
-- and validity are separate axes, and this migration speaks only to the first.
--
-- Additive per ADR-295 on the schema side (one function, one view). The
-- UPDATE is the backfill step of the add → guard → backfill sequence the
-- migration discipline prescribes; it narrows to 'unknown-legacy' rows only.
-- ============================================================

-- ── The classifier ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION classify_legacy_evaluation(
  p_fitness   DOUBLE PRECISION,
  p_safety    DOUBLE PRECISION,
  p_success   DOUBLE PRECISION,
  p_latency   DOUBLE PRECISION,
  p_resource  DOUBLE PRECISION
)
RETURNS TABLE (method TEXT, fingerprint TEXT)
LANGUAGE plpgsql IMMUTABLE
SET search_path = 'public'
AS $$
DECLARE
  eps CONSTANT DOUBLE PRECISION := 1e-6;
  v_base DOUBLE PRECISION;
  v_var  INTEGER;
  v_sv   INTEGER;
BEGIN
  IF p_fitness IS NULL OR p_success IS NULL OR p_latency IS NULL OR p_resource IS NULL THEN
    RETURN QUERY SELECT 'unknown-legacy'::TEXT, 'missing dimensions'::TEXT; RETURN;
  END IF;

  -- publish-default: the exact placeholder tuple
  IF abs(p_fitness - 0.5) < eps AND abs(coalesce(p_safety, -1) - 1) < eps
     AND abs(p_success - 1) < eps AND abs(p_latency - 0.8) < eps AND abs(p_resource - 0.8) < eps THEN
    RETURN QUERY SELECT 'declared'::TEXT, 'publish-default (0.5, 1, 1, 0.8, 0.8)'::TEXT; RETURN;
  END IF;

  -- sandbox: capped at exactly 1.0 with success exactly 1 — unreachable by the estimator
  IF abs(p_fitness - 1.0) < eps AND abs(p_success - 1) < eps THEN
    RETURN QUERY SELECT 'sandbox'::TEXT, 'pre-ADR-318 cap: fitness = 1.0, success = 1'::TEXT; RETURN;
  END IF;

  -- hash-estimate: every dimension an exact thousandth, in range, congruent
  IF abs(p_fitness * 1000 - round(p_fitness * 1000)) < eps
     AND abs(p_success * 1000 - round(p_success * 1000)) < eps
     AND abs(p_latency * 1000 - round(p_latency * 1000)) < eps
     AND abs(p_resource * 1000 - round(p_resource * 1000)) < eps
     AND p_success BETWEEN 0.9 - eps AND 0.999 + eps
     AND p_latency BETWEEN 0.401 - eps AND 0.999 + eps
     AND p_resource BETWEEN 0.301 - eps AND 0.899 + eps THEN
    v_base := CASE WHEN p_fitness >= 0.70 - eps THEN 0.70 ELSE 0.45 END;
    v_var  := round((p_fitness - v_base) * 1000)::INTEGER;
    v_sv   := round((p_success - 0.9) * 1000)::INTEGER;
    IF v_var BETWEEN 0 AND 249 AND ((v_var - v_sv) % 50) = 0 THEN
      RETURN QUERY SELECT 'estimated'::TEXT,
        format('hash-estimate base %s: fitness−base=%s‰, success−0.9=%s‰, congruent mod 50', v_base, v_var, v_sv);
      RETURN;
    END IF;
  END IF;

  -- declared: round two-decimal values on every dimension
  IF abs(p_fitness * 100 - round(p_fitness * 100)) < eps
     AND abs(coalesce(p_safety, 0) * 100 - round(coalesce(p_safety, 0) * 100)) < eps
     AND abs(p_success * 100 - round(p_success * 100)) < eps
     AND abs(p_latency * 100 - round(p_latency * 100)) < eps
     AND abs(p_resource * 100 - round(p_resource * 100)) < eps THEN
    RETURN QUERY SELECT 'declared'::TEXT, 'hand-shaped: every dimension is a round hundredth'::TEXT; RETURN;
  END IF;

  RETURN QUERY SELECT 'unknown-legacy'::TEXT, 'no fingerprint matched'::TEXT;
END;
$$;

COMMENT ON FUNCTION classify_legacy_evaluation(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) IS
  'ADR-319 D2 / plan 2.7: infers how a pre-provenance Arena row was produced from the shape of its numbers. Pure; anyone can re-run it on the public table. Returns (method, fingerprint).';

-- ── The evidence, as a public view ──────────────────────────

CREATE OR REPLACE VIEW arena_legacy_provenance_probe
WITH (security_invoker = true) AS
SELECT
  a.gene_id,
  a.evaluation_method AS recorded_method,
  c.method            AS inferred_method,
  c.fingerprint,
  a.fitness_value, a.safety_score, a.success_rate, a.latency_score, a.resource_efficiency,
  a.created_at
FROM arena_entries a
CROSS JOIN LATERAL classify_legacy_evaluation(
  a.fitness_value, a.safety_score, a.success_rate, a.latency_score, a.resource_efficiency
) AS c;

COMMENT ON VIEW arena_legacy_provenance_probe IS
  'Every Arena row with the provenance its numbers can prove (inferred_method + fingerprint) next to what the ledger records. After the 2.7 backfill these agree for every legacy row; a later disagreement means a new client wrote a shape the classifier does not know.';

GRANT SELECT ON arena_legacy_provenance_probe TO anon, authenticated;

-- ── The backfill ────────────────────────────────────────────
-- Only rows that still say unknown-legacy, only where the classifier is
-- confident. Idempotent.

UPDATE arena_entries a
   SET evaluation_method = c.method
  FROM (
    SELECT e.id,
           (classify_legacy_evaluation(
              e.fitness_value, e.safety_score, e.success_rate, e.latency_score, e.resource_efficiency
           )).method AS method
      FROM arena_entries e
     WHERE e.evaluation_method = 'unknown-legacy'
  ) AS c
 WHERE c.id = a.id
   AND a.evaluation_method = 'unknown-legacy'
   AND c.method <> 'unknown-legacy';
