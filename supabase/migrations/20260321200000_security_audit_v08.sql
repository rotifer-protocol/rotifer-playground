-- ============================================================
-- Migration: v0.8 Security Audit Fixes
-- Rotifer Protocol v0.8
--
-- Fixes 2 CRITICAL + 4 WARNING + 1 SUGGESTION from v0.8 audit:
--
--   C-NEW1: mcp_call_log anonymous unlimited writes
--   C-NEW2: track_download anon bypass (no dedup for anonymous)
--   W-NEW1: search_genes p_limit not capped
--   W-NEW2: suggest_domain missing SET search_path
--   W-NEW3: domain_registry UPDATE allows gene_count tampering
--   W-NEW4: compute_developer_reputation SECURITY DEFINER reverted
--   S-NEW1: check_prev_version_same_owner missing SET search_path
--
-- Also: cleanup audit test data (4 fake downloads + 6 mcp_call_log)
-- ============================================================

BEGIN;

-- =====================
-- C-NEW1 FIX: Lock down mcp_call_log direct writes + create RPC
--
-- Problem: WITH CHECK (true) allows anyone to spam unlimited fake data
-- Fix: Block direct INSERT; provide log_mcp_call() RPC with rate limiting
-- =====================

DROP POLICY IF EXISTS "Anon can insert call logs" ON mcp_call_log;

CREATE POLICY "MCP call logs not directly writable"
  ON mcp_call_log FOR INSERT
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION log_mcp_call(
  p_tool_name text,
  p_gene_id text DEFAULT NULL,
  p_success boolean DEFAULT true,
  p_latency_ms integer DEFAULT 0,
  p_caller text DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_recent_count integer;
BEGIN
  IF p_tool_name IS NULL OR trim(p_tool_name) = '' THEN
    RAISE EXCEPTION 'tool_name is required';
  END IF;

  p_latency_ms := LEAST(GREATEST(p_latency_ms, 0), 300000);

  SELECT COUNT(*) INTO v_recent_count
  FROM mcp_call_log
  WHERE tool_name = p_tool_name
    AND (caller IS NOT DISTINCT FROM p_caller)
    AND created_at > now() - interval '1 minute';

  IF v_recent_count >= 10 THEN
    RETURN;
  END IF;

  INSERT INTO mcp_call_log (tool_name, gene_id, success, latency_ms, caller)
  VALUES (p_tool_name, p_gene_id, p_success, p_latency_ms, p_caller);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION log_mcp_call FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_mcp_call TO anon, authenticated;

-- =====================
-- C-NEW2 FIX: track_download anon dedup
--
-- Problem: anon ip_hash includes now()::text making each hash unique → no dedup
-- Fix: stable IP hash + 24h dedup window for anon callers
-- =====================

CREATE OR REPLACE FUNCTION track_download(p_gene_id UUID)
RETURNS VOID AS $$
DECLARE
  v_caller UUID;
  v_ip_hash text;
BEGIN
  v_caller := auth.uid();

  IF v_caller IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM downloads
      WHERE gene_id = p_gene_id
        AND user_id = v_caller
        AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN;
    END IF;

    INSERT INTO downloads (gene_id, user_id)
    VALUES (p_gene_id, v_caller);
  ELSE
    v_ip_hash := 'anon-' || substr(md5(coalesce(inet_client_addr()::text, 'unknown')), 1, 12);

    IF EXISTS (
      SELECT 1 FROM downloads
      WHERE gene_id = p_gene_id
        AND ip_hash = v_ip_hash
        AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN;
    END IF;

    INSERT INTO downloads (gene_id, ip_hash)
    VALUES (p_gene_id, v_ip_hash);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

-- =====================
-- W-NEW1 FIX: search_genes p_limit cap
--
-- Problem: p_limit accepts 999999999, potential DoS
-- Fix: cap at 200 (same as get_arena_rankings)
-- =====================

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
  p_limit := LEAST(p_limit, 200);
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

-- =====================
-- W-NEW2 FIX: suggest_domain SET search_path
-- =====================

CREATE OR REPLACE FUNCTION suggest_domain(p_description text, p_limit int DEFAULT 3)
RETURNS TABLE (
  domain text,
  description text,
  gene_count integer,
  rank real
) AS $$
BEGIN
  p_limit := LEAST(p_limit, 10);

  RETURN QUERY
  SELECT
    dr.domain,
    dr.description,
    dr.gene_count,
    ts_rank(dr.fts, websearch_to_tsquery('english', p_description)) AS rank
  FROM domain_registry dr
  WHERE dr.fts @@ websearch_to_tsquery('english', p_description)
  ORDER BY rank DESC, dr.gene_count DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = 'public';

-- =====================
-- W-NEW3 FIX: domain_registry UPDATE restricted to description only
--
-- Problem: creator can UPDATE any column including gene_count
-- Fix: column-level GRANT — authenticated can only UPDATE description.
--       Trigger functions run as SECURITY DEFINER (postgres) and bypass this.
-- =====================

REVOKE UPDATE ON domain_registry FROM authenticated;
GRANT UPDATE (description) ON domain_registry TO authenticated;

-- =====================
-- W-NEW4 FIX: Re-declare compute_developer_reputation as SECURITY DEFINER
--
-- Problem: CREATE OR REPLACE in migration 20260320 reverted the 005 ALTER
-- =====================

ALTER FUNCTION compute_developer_reputation(UUID) SECURITY DEFINER;

-- =====================
-- S-NEW1 FIX: check_prev_version_same_owner SET search_path
-- =====================

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
$$ LANGUAGE plpgsql
SET search_path = 'public';

-- =====================
-- CLEANUP: Remove audit test data
-- =====================

DELETE FROM downloads
WHERE gene_id = '23f99ba1-ddaf-4966-beb2-84eab9eef8e4'
  AND ip_hash LIKE 'anon-%'
  AND created_at > now() - interval '1 hour';

UPDATE genes
SET downloads = GREATEST(downloads - 4, 0)
WHERE id = '23f99ba1-ddaf-4966-beb2-84eab9eef8e4';

DELETE FROM mcp_call_log
WHERE caller = 'AUDIT_TEST_attacker'
   OR caller = 'AUDIT_TEST'
   OR tool_name LIKE 'AUDIT_%';

COMMIT;
