-- Migration: Full-text search for genes
-- Adds tsvector column + GIN index + auto-update trigger + search RPC

ALTER TABLE public.genes
  ADD COLUMN IF NOT EXISTS search_vector tsvector DEFAULT NULL;

CREATE OR REPLACE FUNCTION public.genes_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.domain, '')), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_genes_search_vector ON public.genes;
CREATE TRIGGER trg_genes_search_vector
  BEFORE INSERT OR UPDATE OF name, description, domain
  ON public.genes
  FOR EACH ROW
  EXECUTE FUNCTION public.genes_search_vector_update();

UPDATE public.genes SET
  search_vector =
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(domain, '')), 'C');

CREATE INDEX IF NOT EXISTS idx_genes_search_vector
  ON public.genes USING gin(search_vector);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_genes_name_trgm
  ON public.genes USING gin(name gin_trgm_ops);

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
SET search_path = public
AS $$
DECLARE
  ts_query tsquery;
BEGIN
  IF p_query IS NOT NULL AND trim(p_query) <> '' THEN
    ts_query := plainto_tsquery('english', p_query);
  END IF;

  RETURN QUERY
  SELECT
    g.id, g.name, g.domain, g.version, g.fidelity, g.description,
    g.wasm_size, g.downloads, g.reputation_score,
    g.created_at, g.updated_at,
    p.username AS owner_username,
    CASE WHEN ts_query IS NOT NULL THEN ts_rank(g.search_vector, ts_query) ELSE 0 END AS rank
  FROM genes g
  LEFT JOIN profiles p ON g.owner_id = p.id
  WHERE g.published = true
    AND (ts_query IS NULL OR (g.search_vector @@ ts_query OR g.name ILIKE '%' || p_query || '%'))
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

GRANT EXECUTE ON FUNCTION public.search_genes TO anon, authenticated;
