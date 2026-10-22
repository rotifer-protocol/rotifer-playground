-- ============================================================
-- Stop publishing who downloaded a gene and the exact timing of duplicate
-- invocation pairs (T-67a; redteam review .agent-team/drafts/
-- T-67-redteam-review.md items #7 and #8)
--
-- #7  downloads. The policy "Gene owners can view download stats"
--     (20260124120000) lets the author of a gene read every download row of
--     it: user_id (the downloader's account), ip_hash and created_at. An
--     author can publish a gene and learn who installed it and when — and
--     line that up with the invocation log. No client reads these rows: the
--     CLI, MCP server, rotifer-ai, rotifer-dev and rotifer-admin take download
--     numbers from genes.downloads and get_gene_stats(), and every function
--     that reads the table is SECURITY DEFINER (get_gene_stats,
--     track_download, guard_gene_client_delete). So the row-level read goes:
--     SELECT on downloads is revoked from anon and authenticated. The policy
--     stays (it is inert without the grant); get_gene_stats() keeps serving
--     the totals and 7/30/90-day counts.
--
-- #8  gene_invocation_duplicate_probe (ADR-322 D3, 20260819100000) is
--     granted whole to anon and authenticated and carries caller_agent_id,
--     previous_invoked_at, invoked_at and gap: the exact spacing of one
--     caller's consecutive calls. Its only reader, the rotifer-admin pipeline
--     probe, asks for `select=gene_id&after_guard=is.true|false` with an
--     exact count. So:
--       1. the view runs as its owner (security_invoker = false). It was
--          security_invoker so that it would follow the base table's policy;
--          but the base table's caller and time columns are about to be
--          narrowed (T-67), and a security_invoker view would then fail for
--          anon outright. Run as owner, it exposes exactly what is granted
--          on the view, which after step 3 is two columns.
--       2. SELECT on the whole view is revoked from PUBLIC, anon and
--          authenticated (a column revoke cannot narrow a table-level grant);
--       3. SELECT (gene_id, after_guard) is granted back to anon and
--          authenticated. The admin probe's query runs unchanged.
--
-- Left as is, to be settled with T-67's direction: get_gene_stats() is
-- callable by anyone, and polling its 7-day count lets an observer bracket
-- when a download happened (redteam #6).
--
-- Additive per ADR-295: privileges and one view option. No table, column,
-- policy or row changes.
-- ============================================================

REVOKE SELECT ON downloads FROM anon, authenticated;

ALTER VIEW gene_invocation_duplicate_probe SET (security_invoker = false);
REVOKE ALL ON gene_invocation_duplicate_probe FROM PUBLIC, anon, authenticated;
GRANT SELECT (gene_id, after_guard) ON gene_invocation_duplicate_probe TO anon, authenticated;

COMMENT ON VIEW gene_invocation_duplicate_probe IS
  'ADR-322 D3: pairs of consecutive same-(gene,caller) invocations closer than invocation_dedup_window(). Rows with after_guard = true are a regression and must be zero; after_guard = false are the pre-D1 pairs ADR-322 D4 deliberately keeps. Runs as owner; clients may read gene_id and after_guard only (T-67a) — the caller and the timing stay server-side.';
