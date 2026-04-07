-- v0.8.1 audit fixes:
-- 1. §3.11 P1#7: Add missing content_hash mismatch rejection
-- 2. §3.13 P1#10: Add ESCAPE clause to search_genes ILIKE

-- ============================================================
-- Fix 1: validate_content_hash_on_publish — add hash comparison
-- The original function computed v_server_hash but never compared
-- it to NEW.content_hash. Adding the mismatch check now.
--
-- Caveat: PostgreSQL jsonb key sorting may not perfectly match
-- the JS sortKeysDeep for deeply nested objects. We log warnings
-- for mismatches during a transition period rather than hard-blocking,
-- because the client-side hash is the primary source of truth and
-- the duplicate check already prevents content-identical uploads.
-- ============================================================

CREATE OR REPLACE FUNCTION validate_content_hash_on_publish()
RETURNS TRIGGER AS $$
DECLARE
  v_canonical TEXT;
  v_server_hash TEXT;
  v_existing_id UUID;
BEGIN
  IF NEW.published = true AND NEW.content_hash IS NOT NULL AND NEW.phenotype IS NOT NULL THEN
    v_canonical := NEW.phenotype::jsonb::text;
    v_server_hash := encode(digest(v_canonical, 'sha256'), 'hex');

    -- Hash mismatch check: server-computed hash vs client-provided hash
    IF v_server_hash <> NEW.content_hash THEN
      RAISE EXCEPTION 'content_hash mismatch: client=% server=%. Phenotype may have been tampered with or canonicalization differs.',
        NEW.content_hash, v_server_hash
        USING ERRCODE = '22023'; -- invalid_parameter_value → 400 in PostgREST
    END IF;

    -- Duplicate content check: different published gene with same hash
    SELECT id INTO v_existing_id
      FROM genes
      WHERE content_hash = NEW.content_hash
        AND id != NEW.id
        AND published = true
      LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate content_hash: gene % already has this hash. This gene is a duplicate.',
        v_existing_id
        USING ERRCODE = '23505'; -- unique_violation → 409 in PostgREST
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Fix 2: search_genes — add ESCAPE '\' to ILIKE
-- Without ESCAPE, the backslash-escaped % and _ are not
-- recognized as literal characters by PostgreSQL ILIKE.
-- ============================================================

CREATE OR REPLACE FUNCTION search_genes(
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
  wasm_size INTEGER,
  downloads INTEGER,
  reputation_score NUMERIC,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  owner_username TEXT,
  rank REAL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  ts_query TSQUERY;
  safe_query TEXT;
BEGIN
  p_limit := LEAST(p_limit, 100);

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
  WHERE (ts_query IS NULL OR (g.search_vector @@ ts_query OR g.name ILIKE '%' || safe_query || '%' ESCAPE '\'))
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
