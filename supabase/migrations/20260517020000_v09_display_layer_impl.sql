-- ============================================================
-- v0.9 Stage 2 — Display Layer (B-R3 + B-R4 merged sprint)
--   * get_display_fitness(p_gene_id UUID)  — usage diversity factor (§24.2)
--   * get_display_weight(p_gene_id UUID)   — newcomer bonus (§35.3.2 MUST)
-- Plan: protocol-v0.9-plan.md §3.2 (line 480-547 draft, fields corrected)
-- Stage-1 stub commit: rotifer-playground 624468a (2026-05-16)
-- ============================================================
--
-- Stage 1 shipped both RPCs as stubs raising NOT_IMPLEMENTED. This migration
-- replaces the bodies with the canonical logic from plan §3.2 (fields
-- corrected — see §"Plan §3.2 corrections" below).
--
-- pgTAP assertions promoted FAIL → PASS by this migration:
--   B.3.1 — get_display_fitness('00000000-...') → 0.0 (missing gene/arena)
--           was: NOT_IMPLEMENTED stub raised before COALESCE could apply
--
-- All other B.3.x / B.4.x pgTAP assertions remain SELECT skip(...) since
-- they require Gene + author + arena_entries fixture seeding (planned for
-- B-R6 TS E2E sprint via supabase-js + @supabase/supabase-js installation).
--
-- B.3.0, B.3.8 (volatility STABLE), B.4.0 already PASS in stage-1 stub
-- (schema-level checks — has_function + volatility_is).
--
-- Plan §3.2 draft corrections applied here:
--   get_display_fitness (line 480-508):
--     1. arena_entries.score → arena_entries.fitness_value
--        (correct column name; same correction as B-R2 reset_season)
--     2. arena_entries ORDER BY created_at DESC LIMIT 1 → direct JOIN
--        (gene_id is UNIQUE in arena_entries — at most 1 row per gene)
--     3. NULL short-circuit added: missing gene → return 0 (was: would
--        return NULL × GREATEST(...) = NULL, failing B.3.1's is(... 0.0))
--   get_display_weight (line 518-546):
--     1. genes.author_id → genes.owner_id
--        (author_id field does NOT exist on genes table; owner_id is the
--         FK to profiles per initial.sql)
--     2. g2.lifecycle_state != 'Draft' → g2.published = true
--        (lifecycle_state field does NOT exist; published BOOLEAN is the
--         actual draft/published flag per initial.sql)
--     3. ORDER BY season_number DESC + LIMIT 1 added — matches B-R2
--        idiom for picking the active season deterministically when
--        multiple rows exist transiently during reset_season().
-- ------------------------------------------------------------
-- 1. get_display_fitness — usage diversity factor (§24.2)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_display_fitness(p_gene_id UUID)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_raw_fitness         DOUBLE PRECISION;
  v_gene_domain         TEXT;
  v_alpha               DOUBLE PRECISION;
  v_usage_freq          DOUBLE PRECISION;
  v_total_domain_usage  DOUBLE PRECISION;
  v_diversity           DOUBLE PRECISION;
BEGIN
  -- Look up the Gene's raw fitness + domain in one go.
  -- arena_entries.gene_id is UNIQUE (initial.sql:51), so the JOIN yields
  -- at most one row.
  SELECT ae.fitness_value, g.domain
    INTO v_raw_fitness, v_gene_domain
  FROM arena_entries ae
  JOIN genes g ON g.id = ae.gene_id
  WHERE ae.gene_id = p_gene_id;

  -- B.3.1: missing gene/arena_entries → return 0 (NOT NULL).
  IF v_raw_fitness IS NULL THEN
    RETURN 0.0;
  END IF;

  -- B.3.5: alpha read from active season config; D-02 default 0.5.
  -- (Spec recommends 0.3; v0.9 picks 0.5 per plan-level decision D-02 to
  --  apply stronger anti-monopoly pressure on a small early ecosystem.)
  SELECT (config->>'diversity_factor_alpha')::DOUBLE PRECISION
    INTO v_alpha
  FROM seasons
  WHERE status = 'active'
  ORDER BY season_number DESC
  LIMIT 1;
  v_alpha := COALESCE(v_alpha, 0.5);

  -- B.3.2: usage_freq = 0 → diversity = 1 (full bonus, no penalty).
  SELECT COALESCE(total_invocations, 0)::DOUBLE PRECISION
    INTO v_usage_freq
  FROM gene_contribution_metrics
  WHERE gene_id = p_gene_id;
  v_usage_freq := COALESCE(v_usage_freq, 0);

  -- B.3.3: monopoly (usage_freq = total_domain_usage) → diversity floor 0.1.
  SELECT COALESCE(SUM(cm.total_invocations), 0)::DOUBLE PRECISION
    INTO v_total_domain_usage
  FROM gene_contribution_metrics cm
  JOIN genes g ON g.id = cm.gene_id
  WHERE g.domain = v_gene_domain;

  -- Guard division by zero for empty/quiet domains.
  v_total_domain_usage := GREATEST(v_total_domain_usage, 1.0);

  -- diversity_factor(g) = 1.0 - (usage_freq(g) / total_domain_usage) ^ alpha
  v_diversity := 1.0 - POWER(v_usage_freq / v_total_domain_usage, v_alpha);

  -- Floor 0.1 prevents over-penalisation; ceiling is the natural 1.0.
  RETURN v_raw_fitness * GREATEST(v_diversity, 0.1);
END;
$$ LANGUAGE plpgsql STABLE SET search_path = 'public';

-- Permissions unchanged from stub (display layer is read-only; STABLE
-- function is callable from any role — RLS on underlying tables enforces
-- visibility constraints at the data layer).

-- ------------------------------------------------------------
-- 2. get_display_weight — newcomer bonus (§35.3.2 MUST)
-- ------------------------------------------------------------
--
-- Per spec §35.3.2: the protection target is the **author** (developer),
-- not an individual Gene. Bonus applies when the author's *earliest*
-- publish date falls within the protection window.

CREATE OR REPLACE FUNCTION get_display_weight(p_gene_id UUID)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  v_owner_id            UUID;
  v_author_first        TIMESTAMPTZ;
  v_protection_days     INTEGER;
  v_bonus_multiplier    DOUBLE PRECISION;
BEGIN
  -- Find the Gene's owner; missing Gene → no bonus (return 1.0 baseline).
  SELECT owner_id
    INTO v_owner_id
  FROM genes
  WHERE id = p_gene_id;

  IF v_owner_id IS NULL THEN
    RETURN 1.0;
  END IF;

  -- B.4.3 Strict-Test (§35.3.2): take the author's earliest published
  -- Gene's created_at — protection follows the developer, not the Gene.
  -- B.4.4: Draft Genes (published = false) excluded from the calculation.
  SELECT MIN(created_at)
    INTO v_author_first
  FROM genes
  WHERE owner_id = v_owner_id
    AND published = true;

  -- Edge case: author has no published Genes (e.g. all drafts). No bonus.
  IF v_author_first IS NULL THEN
    RETURN 1.0;
  END IF;

  -- B.4.5/B.4.6: protection_days + bonus_multiplier from active season.
  SELECT
    (config->>'newcomer_protection_days')::INTEGER,
    (config->>'newcomer_bonus_multiplier')::DOUBLE PRECISION
    INTO v_protection_days, v_bonus_multiplier
  FROM seasons
  WHERE status = 'active'
  ORDER BY season_number DESC
  LIMIT 1;

  v_protection_days  := COALESCE(v_protection_days, 30);
  v_bonus_multiplier := COALESCE(v_bonus_multiplier, 1.5);

  -- B.4.1: within window → bonus.   B.4.2: at boundary 31d outside → 1.0.
  IF v_author_first + (v_protection_days || ' days')::INTERVAL > now() THEN
    RETURN v_bonus_multiplier;
  ELSE
    RETURN 1.0;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = 'public';
