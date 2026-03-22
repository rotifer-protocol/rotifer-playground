-- Migration: Fix domain_registry.gene_count to count unique genes only
--
-- Bug: The backfill used count(*) which counts all published versions,
-- inflating gene_count for domains with multi-version genes.
--
-- Fix: Recount using COUNT(DISTINCT (owner_id, name)) per domain.

UPDATE domain_registry dr
SET gene_count = sub.cnt
FROM (
  SELECT g.domain, COUNT(DISTINCT (g.owner_id, g.name))::integer AS cnt
  FROM genes g
  WHERE g.published = true
  GROUP BY g.domain
) sub
WHERE dr.domain = sub.domain;
