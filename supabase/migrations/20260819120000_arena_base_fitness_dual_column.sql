-- ============================================================
-- §5.1 / §33.1 (spec v2.11): the dual-column fitness contract
--
-- F(g) = base_fitness × FIDELITY_DISCOUNT[fidelity]
--   FIDELITY_DISCOUNT = { native: 1.00, hybrid: 0.85, wrapped: 0.70 }
--
-- The spec asks the Arena to show both numbers side by side: the raw
-- base_fitness reveals what the gene can nominally do, the discounted F(g)
-- reveals its standing under cross-fidelity competition. Until now the ledger
-- held only fitness_value — and the CLI never applied the discount at all, so
-- fitness_value was base_fitness by accident, for every fidelity alike.
--
-- Two columns rather than one, so the multiplication is reconstructible from
-- the row itself (§9.7.1): a reader who has fitness_value and base_fitness but
-- not the discount that was in force at submission time cannot tell whether
-- the number was discounted, or by which version of the table.
--
-- Both nullable. Rows written before this migration genuinely do not know
-- their base — their fitness_value was never discounted, so technically
-- base = fitness_value and discount = 1.0 — but writing that in would be
-- inventing provenance for rows whose evaluation_method is already
-- 'unknown-legacy'. They stay NULL, which reads correctly as "not recorded".
--
-- Additive per ADR-295: two ADD COLUMN, two CHECK constraints on the new
-- columns only. No existing data touched.
-- ============================================================

ALTER TABLE arena_entries
  ADD COLUMN IF NOT EXISTS base_fitness      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS fidelity_discount DOUBLE PRECISION;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_base_fitness_range') THEN
    ALTER TABLE arena_entries
      ADD CONSTRAINT chk_arena_base_fitness_range
      CHECK (base_fitness IS NULL OR (base_fitness >= 0 AND base_fitness <= 1));
  END IF;

  -- The discount is a protocol parameter in (0, 1]. Anything outside that is
  -- not a fidelity discount, whatever the client called it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_fidelity_discount_range') THEN
    ALTER TABLE arena_entries
      ADD CONSTRAINT chk_arena_fidelity_discount_range
      CHECK (fidelity_discount IS NULL OR (fidelity_discount > 0 AND fidelity_discount <= 1));
  END IF;

  -- Either both recorded or neither. A base without its discount, or a
  -- discount without its base, cannot reconstruct anything.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arena_dual_column_pair') THEN
    ALTER TABLE arena_entries
      ADD CONSTRAINT chk_arena_dual_column_pair
      CHECK ((base_fitness IS NULL) = (fidelity_discount IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN arena_entries.base_fitness IS
  'Raw fitness before the fidelity discount (spec §5.1 / §33.1 dual-column). fitness_value = base_fitness × fidelity_discount. NULL on rows written before the discount was applied.';
COMMENT ON COLUMN arena_entries.fidelity_discount IS
  'FIDELITY_DISCOUNT[fidelity] in force at submission (spec §5.1: native 1.00 / hybrid 0.85 / wrapped 0.70, a PAP-adjustable protocol parameter). Recorded per row so the multiplication stays reconstructible after the parameter moves.';
