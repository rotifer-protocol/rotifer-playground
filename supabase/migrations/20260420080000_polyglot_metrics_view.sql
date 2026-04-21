-- Polyglot Adoption Metrics view.
--
-- Exposes aggregate signals about source-language diversity in the gene
-- registry: how many genes / contributors come from outside the core team,
-- how many are written in non-TypeScript languages, etc.
--
-- The "team whitelist" used here is NOT an access-control gate. Anyone with
-- a profile can publish a gene; this view simply tags publishes by team
-- members so the dashboard can subtract them from totals and show the
-- genuine external signal.
--
-- The whitelist is intentionally inlined in this migration so that the SQL
-- view stays self-contained. A mirror copy lives in
-- `rotifer-admin/src/lib/team-whitelist.ts` for the dashboard's local checks;
-- both files MUST be updated together when membership changes.

CREATE OR REPLACE VIEW v_polyglot_metrics AS
WITH team AS (
  -- ⚠️ Replace placeholder usernames before deploying. Keep in sync with
  --    rotifer-admin/src/lib/team-whitelist.ts
  SELECT unnest(ARRAY[
    '__TEAM_GITHUB_USERNAME_TODO__'
  ]::text[]) AS github_username
),
published_with_owner AS (
  SELECT
    g.id,
    g.owner_id,
    coalesce(g.phenotype->>'sourceLanguage', 'typescript') AS source_language,
    p.username AS owner_username
  FROM genes g
  JOIN profiles p ON p.id = g.owner_id
  WHERE g.published = true
)
SELECT
  COUNT(*)::int AS total_genes,
  COUNT(DISTINCT owner_id)::int AS total_contributors,
  COUNT(*) FILTER (
    WHERE owner_username NOT IN (SELECT github_username FROM team)
  )::int AS external_genes,
  COUNT(DISTINCT owner_id) FILTER (
    WHERE owner_username NOT IN (SELECT github_username FROM team)
  )::int AS external_contributors,
  COUNT(*) FILTER (
    WHERE source_language NOT IN ('typescript', 'unknown')
  )::int AS non_ts_genes,
  COUNT(*) FILTER (WHERE source_language = 'rust')::int AS rust_genes,
  COUNT(*) FILTER (WHERE source_language = 'assemblyscript')::int AS assemblyscript_genes,
  COUNT(*) FILTER (WHERE source_language = 'go')::int AS go_genes,
  COUNT(*) FILTER (WHERE source_language = 'c')::int AS c_genes,
  COUNT(*) FILTER (WHERE source_language = 'external')::int AS external_lang_genes
FROM published_with_owner;

-- Aggregates contain no PII or sensitive data; expose to anon + authenticated.
-- View inherits SECURITY INVOKER semantics, which means RLS on the underlying
-- `genes` and `profiles` tables still applies to whoever queries it.
GRANT SELECT ON v_polyglot_metrics TO anon, authenticated;

-- Per-language breakdown view for trend charts.
CREATE OR REPLACE VIEW v_polyglot_genes_by_language AS
SELECT
  coalesce(g.phenotype->>'sourceLanguage', 'typescript') AS source_language,
  COUNT(*)::int AS gene_count,
  COUNT(DISTINCT g.owner_id)::int AS contributor_count
FROM genes g
WHERE g.published = true
GROUP BY 1
ORDER BY gene_count DESC;

GRANT SELECT ON v_polyglot_genes_by_language TO anon, authenticated;
