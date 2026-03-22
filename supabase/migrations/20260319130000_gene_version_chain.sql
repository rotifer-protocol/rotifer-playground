-- ============================================================
-- Migration 013: Gene Version Chain
-- Rotifer Protocol v0.7.5 (ADR-094 D2)
--
-- Implements §4.6 GeneVersionChain: previousVersionId + changelog.
-- Backfills previous_version_id for existing multi-version genes.
-- ============================================================

BEGIN;

-- New columns (both nullable per migration rules)
ALTER TABLE genes ADD COLUMN previous_version_id uuid REFERENCES genes(id);
ALTER TABLE genes ADD COLUMN changelog text;

CREATE INDEX idx_genes_prev_version ON genes(previous_version_id);

-- Backfill: link versions by created_at order within same (owner_id, name)
UPDATE genes g
SET previous_version_id = (
  SELECT g2.id
  FROM genes g2
  WHERE g2.owner_id = g.owner_id
    AND g2.name = g.name
    AND g2.created_at < g.created_at
  ORDER BY g2.created_at DESC
  LIMIT 1
);

-- Ownership enforcement: previous_version_id must point to same owner's gene.
-- PostgreSQL CHECK constraints do not support subqueries, so we use a trigger.
CREATE OR REPLACE FUNCTION check_prev_version_same_owner()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.previous_version_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM genes
      WHERE id = NEW.previous_version_id
        AND owner_id = NEW.owner_id
    ) THEN
      RAISE EXCEPTION 'previous_version_id must reference a gene owned by the same user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_genes_check_prev_version
  BEFORE INSERT OR UPDATE ON genes
  FOR EACH ROW
  EXECUTE FUNCTION check_prev_version_same_owner();

COMMIT;
