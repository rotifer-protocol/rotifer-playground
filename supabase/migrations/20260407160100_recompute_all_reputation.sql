-- D54 + D58: Full reputation recomputation after formula changes
-- ADR-214 (dynamic weights) + ADR-216 (AVG→Σ)

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM genes WHERE published = true LOOP
    PERFORM compute_gene_reputation(r.id);
  END LOOP;

  FOR r IN SELECT DISTINCT owner_id FROM genes WHERE published = true AND owner_id IS NOT NULL LOOP
    PERFORM compute_developer_reputation(r.owner_id);
  END LOOP;
END;
$$;
