-- ============================================================
-- §3.11 P1: content_hash enforcement
-- Depends on: 20260330120000 (added content_hash column)
-- ============================================================

-- Fix version immutability trigger: allow security metadata updates
-- (content_hash, wasm_hash) on published genes while still blocking
-- content changes (name, phenotype, version, etc.)
CREATE OR REPLACE FUNCTION enforce_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.published = true THEN
    -- Allow updates that ONLY modify security metadata fields
    IF (
      NEW.name IS NOT DISTINCT FROM OLD.name AND
      NEW.domain IS NOT DISTINCT FROM OLD.domain AND
      NEW.version IS NOT DISTINCT FROM OLD.version AND
      NEW.phenotype IS NOT DISTINCT FROM OLD.phenotype AND
      NEW.description IS NOT DISTINCT FROM OLD.description AND
      NEW.readme IS NOT DISTINCT FROM OLD.readme AND
      NEW.fidelity IS NOT DISTINCT FROM OLD.fidelity AND
      NEW.published IS NOT DISTINCT FROM OLD.published AND
      NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Published gene version is immutable. Bump version number to publish updates.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

-- Trigger: require content_hash when a gene is published
CREATE OR REPLACE FUNCTION require_content_hash_on_publish()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.published = true AND NEW.content_hash IS NULL THEN
    RAISE EXCEPTION 'content_hash is required for published genes. '
      'Compute it client-side with contentHash(phenotype) before publishing.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_require_content_hash ON genes;
CREATE TRIGGER trg_require_content_hash
  BEFORE INSERT OR UPDATE ON genes
  FOR EACH ROW
  WHEN (NEW.published = true)
  EXECUTE FUNCTION require_content_hash_on_publish();
