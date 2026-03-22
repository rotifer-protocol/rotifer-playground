-- Migration: Fix search_genes to return only the latest version per (owner, name)
-- Previously returned all published versions, causing duplicate gene entries

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
  WHERE (ts_query IS NULL OR (g.search_vector @@ ts_query OR g.name ILIKE '%' || p_query || '%'))
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
