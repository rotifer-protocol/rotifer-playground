-- Migration: make search_genes return an exact total_count
-- This lets CLI clients show truthful "x of y" pagination without
-- reconstructing totals client-side.

DROP FUNCTION IF EXISTS public.search_genes(TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER);

CREATE FUNCTION public.search_genes(
  p_query TEXT DEFAULT NULL,
  p_domain TEXT DEFAULT NULL,
  p_fidelity TEXT DEFAULT NULL,
  p_sort TEXT DEFAULT 'relevance',
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  domain TEXT,
  version TEXT,
  fidelity TEXT,
  description TEXT,
  wasm_size BIGINT,
  downloads BIGINT,
  reputation_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  owner_username TEXT,
  rank REAL,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  ts_query TSQUERY;
  safe_query TEXT;
BEGIN
  p_limit := LEAST(GREATEST(p_limit, 1), 100);
  p_offset := GREATEST(p_offset, 0);

  IF p_query IS NOT NULL AND trim(p_query) != '' THEN
    safe_query := replace(replace(p_query, '%', '\%'), '_', '\_');
    BEGIN
      ts_query := plainto_tsquery('english', p_query);
    EXCEPTION WHEN OTHERS THEN
      ts_query := NULL;
    END;
  END IF;

  RETURN QUERY
  WITH latest_versions AS (
    SELECT DISTINCT ON (gl.owner_id, gl.name)
      gl.id
    FROM genes gl
    WHERE gl.published = true
    ORDER BY gl.owner_id, gl.name, gl.created_at DESC
  ),
  matching_genes AS (
    SELECT
      g.id,
      g.name,
      g.domain,
      g.version,
      g.fidelity,
      g.description,
      g.wasm_size,
      g.downloads,
      g.reputation_score,
      g.created_at,
      g.updated_at,
      p.username AS owner_username,
      CASE WHEN ts_query IS NOT NULL THEN ts_rank(g.search_vector, ts_query) ELSE 0 END AS rank
    FROM genes g
    INNER JOIN latest_versions lv ON g.id = lv.id
    LEFT JOIN profiles p ON g.owner_id = p.id
    WHERE (ts_query IS NULL OR (g.search_vector @@ ts_query OR g.name ILIKE '%' || safe_query || '%' ESCAPE '\'))
      AND (p_domain IS NULL OR g.domain = p_domain)
      AND (p_fidelity IS NULL OR g.fidelity = p_fidelity)
  )
  SELECT
    mg.id,
    mg.name,
    mg.domain,
    mg.version,
    mg.fidelity,
    mg.description,
    mg.wasm_size,
    mg.downloads,
    mg.reputation_score,
    mg.created_at,
    mg.updated_at,
    mg.owner_username,
    mg.rank,
    COUNT(*) OVER()::BIGINT AS total_count
  FROM matching_genes mg
  ORDER BY
    CASE WHEN p_sort = 'relevance' AND ts_query IS NOT NULL
      THEN mg.rank END DESC NULLS LAST,
    CASE WHEN p_sort = 'newest' OR (p_sort = 'relevance' AND ts_query IS NULL)
      THEN mg.created_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'reputation' THEN mg.reputation_score END DESC NULLS LAST,
    CASE WHEN p_sort = 'downloads' THEN mg.downloads END DESC NULLS LAST,
    mg.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_genes TO anon, authenticated;
