-- ============================================================
-- Migration 012: Domain Registry
-- Rotifer Protocol v0.7.5 (ADR-094 D1)
--
-- Establishes a domain registry to reduce domain fragmentation.
-- Backfills from existing genes table.
-- ============================================================

BEGIN;

-- Domain registry table
CREATE TABLE domain_registry (
  domain text PRIMARY KEY,
  description text,
  parent_domain text REFERENCES domain_registry(domain),
  created_by uuid REFERENCES profiles(id),
  gene_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_domain_registry_parent ON domain_registry(parent_domain);

-- Full-text search on domain + description
ALTER TABLE domain_registry ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(domain, '') || ' ' ||
      replace(coalesce(domain, ''), '.', ' ') || ' ' ||
      coalesce(description, '')
    )
  ) STORED;

CREATE INDEX idx_domain_registry_fts ON domain_registry USING gin(fts);

-- RLS
ALTER TABLE domain_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read domain registry"
  ON domain_registry FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can register domains"
  ON domain_registry FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Creator can update own domain entry"
  ON domain_registry FOR UPDATE
  USING (created_by = auth.uid());

-- Backfill: extract unique domains from existing genes
INSERT INTO domain_registry (domain, gene_count, created_by)
SELECT
  g.domain,
  count(*)::integer,
  (array_agg(g.owner_id ORDER BY g.created_at ASC))[1]
FROM genes g
WHERE g.published = true
GROUP BY g.domain
ON CONFLICT DO NOTHING;

-- Backfill parent domains: for 'a.b' set parent to 'a' if 'a' exists
UPDATE domain_registry dr
SET parent_domain = split_part(dr.domain, '.', 1)
WHERE dr.domain LIKE '%.%'
  AND EXISTS (
    SELECT 1 FROM domain_registry dr2
    WHERE dr2.domain = split_part(dr.domain, '.', 1)
  );

-- RPC: suggest domains based on description text
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
$$ LANGUAGE plpgsql STABLE;

COMMIT;
