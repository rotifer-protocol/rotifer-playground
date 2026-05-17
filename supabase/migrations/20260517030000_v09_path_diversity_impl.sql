-- ============================================================
-- v0.9 Stage 2 — compute_path_diversity (B-R5)
--   Jaccard distance over phenotype.dependencies, per-domain
-- Plan: protocol-v0.9-plan.md §3.2 (line 549-583 draft, helper inlined)
-- Source: 2026-04-08 roundtable — Ramanujan R1 path-diversity insight
-- Stage-1 stub commit: rotifer-playground 624468a (2026-05-16)
-- ============================================================
--
-- Stage 1 shipped compute_path_diversity() as a stub raising NOT_IMPLEMENTED.
-- This migration replaces the body with an inlined Jaccard implementation.
--
-- pgTAP assertions promoted FAIL → PASS by this migration: NONE NEW.
-- All B.5.1-B.5.5 assertions are SELECT skip(...) — they require Gene +
-- phenotype.dependencies fixture seeding (deferred to B-R6 TS E2E sprint).
-- B.5.0 has_function already PASS in stage-1 (schema-level check).
--
-- However, replacing the stub IS valuable: B.9.x E2E tests (also currently
-- skipped pending @supabase/supabase-js install) will exercise the real
-- function once the supabase-js dependency lands.
--
-- Plan §3.2 draft corrections applied here:
--   1. plan-§3.2 draft references compute_jaccard_similarity(a, b) helper
--      — that function does NOT exist anywhere in the migrations. The
--      draft was a sketch placeholder. This migration inlines the full
--      Jaccard logic in a plpgsql LOOP rather than introducing a separate
--      helper RPC (keeps the surface area minimal; Jaccard is only used
--      from this one call site).
--   2. Empty-dependencies guard added (B.5.5: "no NaN") — covers (a)
--      target gene missing dependencies field; (b) other gene missing it;
--      (c) both empty, in which case Jaccard is undefined → vacuous
--      similarity = 1.0 chosen (over 0.0) so identical empty-deps clusters
--      get correctly penalised toward floor 0.3 rather than scoring 1.0.
--   3. jsonb_typeof != 'array' guard — phenotype.dependencies could
--      legally be `null`, omitted, or wrong type if a buggy Gene was
--      published; treat all non-array cases as `[]` to fail soft.
--
-- Algorithm:
--   diversity(g, domain) = max(1.0 − avg_similarity, 0.3)
--   avg_similarity       = mean over all OTHER published Genes in domain
--                          of Jaccard(g.deps, other.deps)
--   Jaccard(A, B)        = |A ∩ B| / |A ∪ B|, with 0/0 ↦ 1.0

CREATE OR REPLACE FUNCTION compute_path_diversity(p_gene_id UUID, p_domain TEXT)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_gene_exists       BOOLEAN;
  v_target_deps       JSONB;
  v_other_deps        JSONB;
  v_other_id          UUID;
  v_intersect_cnt     INTEGER;
  v_union_cnt         INTEGER;
  v_similarity        DOUBLE PRECISION;
  v_sum_similarity    DOUBLE PRECISION := 0;
  v_count             INTEGER          := 0;
  v_avg_similarity    DOUBLE PRECISION;
BEGIN
  -- Step 1: existence check + target dependencies extraction.
  SELECT
    TRUE,
    COALESCE(phenotype->'dependencies', '[]'::jsonb)
    INTO v_gene_exists, v_target_deps
  FROM genes
  WHERE id = p_gene_id;

  -- Missing gene → vacuously most diverse (return 1.0 — no penalty).
  IF NOT FOUND OR v_gene_exists IS NULL THEN
    RETURN 1.0;
  END IF;

  -- Guard: dependencies field present but not an array → treat as empty.
  IF jsonb_typeof(v_target_deps) IS DISTINCT FROM 'array' THEN
    v_target_deps := '[]'::jsonb;
  END IF;

  -- Step 2: iterate over OTHER published Genes in the same domain.
  FOR v_other_id, v_other_deps IN
    SELECT
      g.id,
      COALESCE(g.phenotype->'dependencies', '[]'::jsonb)
    FROM genes g
    WHERE g.domain = p_domain
      AND g.id != p_gene_id
      AND g.published = true
  LOOP
    -- Same array-type guard for the comparand.
    IF jsonb_typeof(v_other_deps) IS DISTINCT FROM 'array' THEN
      v_other_deps := '[]'::jsonb;
    END IF;

    -- |A ∩ B| — count target elements that also appear in the other.
    SELECT COUNT(*)::INTEGER
      INTO v_intersect_cnt
    FROM jsonb_array_elements_text(v_target_deps) AS a(value)
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_other_deps) AS b(value)
      WHERE b.value = a.value
    );

    -- |A ∪ B| = |A| + |B| − |A ∩ B|  (assumes within-array uniqueness;
    -- typical phenotype.dependencies satisfies this — duplicate deps
    -- in the same Gene would be a separate validation concern).
    v_union_cnt := jsonb_array_length(v_target_deps)
                 + jsonb_array_length(v_other_deps)
                 - v_intersect_cnt;

    -- B.5.5: empty union → similarity 1.0 vacuously (no division by 0).
    IF v_union_cnt = 0 THEN
      v_similarity := 1.0;
    ELSE
      v_similarity := v_intersect_cnt::DOUBLE PRECISION / v_union_cnt;
    END IF;

    v_sum_similarity := v_sum_similarity + v_similarity;
    v_count          := v_count + 1;
  END LOOP;

  -- B.5.1: single Gene in domain (no comparand) → no penalty, return 1.0.
  IF v_count = 0 THEN
    RETURN 1.0;
  END IF;

  v_avg_similarity := v_sum_similarity / v_count;

  -- B.5.2: identical phenotypes → avg = 1.0 → diversity = 0 → floor 0.3
  -- B.5.4: output ∈ [0.3, 1.0]
  RETURN GREATEST(1.0 - v_avg_similarity, 0.3);
END;
$$ LANGUAGE plpgsql STABLE SET search_path = 'public';

-- Permissions unchanged from stub — STABLE function, RLS on genes
-- (published = true public read) gates underlying data visibility.
