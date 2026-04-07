-- v0.8.1 Security Hardening Migration (idempotent — safe to re-run)
-- Covers: §3.12 P0#1 (Arena CHECK), §3.13 P0#4 (search_genes limit),
--         §3.13 P0#5 (compute_reputation service_role), §3.13 P0#6 (domain_registry),
--         §3.14 P0#3 (RLS column-level), §3.14 P0#4 (get_gene_detail search_path)

-- ============================================================
-- §3.12 P0#1: Arena score CHECK constraints (idempotent)
-- ============================================================
DO $$ BEGIN
  ALTER TABLE arena_entries
    ADD CONSTRAINT chk_fitness_value CHECK (fitness_value BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE arena_entries
    ADD CONSTRAINT chk_safety_score CHECK (safety_score BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE arena_entries
    ADD CONSTRAINT chk_success_rate CHECK (success_rate BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE arena_entries
    ADD CONSTRAINT chk_latency_score CHECK (latency_score BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE arena_entries
    ADD CONSTRAINT chk_resource_efficiency CHECK (resource_efficiency BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- §3.14 P0#3: RLS column-level tightening for genes UPDATE
-- Prevent owners from self-inflating downloads and reputation_score
-- ============================================================
DROP POLICY IF EXISTS "Owners can update own genes" ON genes;
DROP POLICY IF EXISTS "Owners can update own genes (restricted columns)" ON genes;

CREATE POLICY "Owners can update own genes (restricted columns)"
  ON genes FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (
    auth.uid() = owner_id
    AND downloads = (SELECT g.downloads FROM genes g WHERE g.id = genes.id)
    AND reputation_score = (SELECT g.reputation_score FROM genes g WHERE g.id = genes.id)
  );

-- ============================================================
-- §3.14 P0#4: get_gene_detail SET search_path
-- ============================================================
ALTER FUNCTION get_gene_detail(text) SET search_path = 'public';

-- ============================================================
-- §3.13 P0#4: search_genes limit cap 200 → 100
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_genes(
  p_query text,
  p_domain text DEFAULT NULL,
  p_fidelity text DEFAULT NULL,
  p_sort text DEFAULT 'relevance',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  name text,
  domain text,
  version text,
  fidelity text,
  description text,
  wasm_size bigint,
  downloads bigint,
  reputation_score double precision,
  created_at timestamptz,
  updated_at timestamptz,
  owner_username text,
  rank real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  ts_query tsquery;
BEGIN
  p_limit := LEAST(p_limit, 100);
  p_offset := GREATEST(p_offset, 0);

  IF p_query IS NOT NULL AND trim(p_query) <> '' THEN
    ts_query := plainto_tsquery('english', p_query);
  END IF;

  RETURN QUERY
  WITH latest_versions AS (
    SELECT DISTINCT ON (gl.owner_id, gl.name)
      gl.id
    FROM genes gl
    WHERE gl.published = true
    ORDER BY gl.owner_id, gl.name, gl.created_at DESC
  )
  SELECT
    g.id, g.name, g.domain, g.version, g.fidelity, g.description,
    g.wasm_size, g.downloads, g.reputation_score,
    g.created_at, g.updated_at,
    p.username AS owner_username,
    CASE WHEN ts_query IS NOT NULL THEN ts_rank(g.search_vector, ts_query) ELSE 0 END AS rank
  FROM genes g
  INNER JOIN latest_versions lv ON g.id = lv.id
  LEFT JOIN profiles p ON g.owner_id = p.id
  WHERE (ts_query IS NULL OR (g.search_vector @@ ts_query OR g.name ILIKE '%' || replace(replace(p_query, '%', '\%'), '_', '\_') || '%'))
    AND (p_domain IS NULL OR g.domain = p_domain)
    AND (p_fidelity IS NULL OR g.fidelity = p_fidelity)
  ORDER BY
    CASE WHEN p_sort = 'relevance' AND ts_query IS NOT NULL
      THEN ts_rank(g.search_vector, ts_query) END DESC NULLS LAST,
    CASE WHEN p_sort = 'newest' OR (p_sort = 'relevance' AND ts_query IS NULL)
      THEN g.created_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'reputation' THEN g.reputation_score END DESC NULLS LAST,
    CASE WHEN p_sort = 'downloads' THEN g.downloads END DESC NULLS LAST,
    g.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- ============================================================
-- §3.13 P0#5: compute_gene_reputation → service_role only
-- ============================================================
REVOKE EXECUTE ON FUNCTION compute_gene_reputation(UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION compute_gene_reputation(UUID) FROM anon;

REVOKE EXECUTE ON FUNCTION compute_developer_reputation(UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION compute_developer_reputation(UUID) FROM anon;

-- ============================================================
-- §3.13 P0#6: domain_registry validation + rate limiting
-- Fixed: column is "domain" (not "name"), owner is "created_by" (not "owner_id")
-- ============================================================
DO $$ BEGIN
  ALTER TABLE domain_registry
    ADD CONSTRAINT chk_domain_name_format
    CHECK (domain ~ '^[a-z][a-z0-9._-]{0,62}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION check_domain_rate_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*) FROM domain_registry
    WHERE created_by = NEW.created_by
      AND created_at > now() - interval '1 hour'
  ) >= 5 THEN
    RAISE EXCEPTION 'Rate limit: max 5 domain registrations per hour';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_domain_rate_limit ON domain_registry;
CREATE TRIGGER trg_domain_rate_limit
  BEFORE INSERT ON domain_registry
  FOR EACH ROW
  EXECUTE FUNCTION check_domain_rate_limit();

-- ============================================================
-- §3.12 P0#4: WASM hash + content hash columns
-- ============================================================
ALTER TABLE genes
  ADD COLUMN IF NOT EXISTS wasm_hash TEXT,
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- ============================================================
-- §3.12 P0#6: Version immutability — block overwrites of published genes
-- ============================================================
CREATE OR REPLACE FUNCTION enforce_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.published = true THEN
    RAISE EXCEPTION 'Published gene version is immutable. Bump version number to publish updates.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_version_immutability ON genes;
CREATE TRIGGER trg_version_immutability
  BEFORE UPDATE ON genes
  FOR EACH ROW
  WHEN (OLD.published = true)
  EXECUTE FUNCTION enforce_version_immutability();
