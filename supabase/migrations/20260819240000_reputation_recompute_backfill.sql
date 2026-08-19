-- ============================================================
-- ADR-319 D4 — the one-time R(g) backfill, authorised 2026-08-19
--
-- 20260819230000 changed the formula so that R(g) can no longer spend a
-- fitness value the Arena criteria disqualified. Replacing a function does
-- not restate what is already written, so every stored score kept the old
-- number: verified immediately after that push, 103 published genes still
-- carried R(g) > 0, `hook-guard` still read 0.604547620805922 of which 0.567
-- came from an invalidated 0.81.
--
-- That migration defined `recompute_all_published_reputation()` and
-- deliberately did not call it, because restating a public number on every
-- gene is a data decision rather than a schema one. It has now been made.
-- This migration is that decision, and nothing else — it is separate on
-- purpose so the ledger records when the numbers moved and on whose word.
--
-- Projected from production before running (read-only, new formula applied
-- to live rows): of 182 published genes, 101 fall and 54 of those to zero,
-- none rise; genes with R(g) > 0 go 103 → 49; every surviving value lands
-- under 0.08, being usage and stability only. The six evolve-life / particle
-- genes fall furthest, 0.7375 → 0.
--
-- Nothing is deleted here either. `gene_reputation` keeps every previous
-- epoch, so the old score and its breakdown stay readable next to the new
-- one — the recomputation is auditable rather than a silent overwrite.
--
-- Additive per ADR-295: no schema change, one function call.
-- ============================================================

DO $$
DECLARE
  v_genes INTEGER;
  v_devs INTEGER;
BEGIN
  SELECT genes_recomputed, developers_recomputed
    INTO v_genes, v_devs
    FROM recompute_all_published_reputation();

  RAISE NOTICE 'R(g) backfill: recomputed % published genes and % developers', v_genes, v_devs;
END;
$$;
