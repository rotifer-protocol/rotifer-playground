-- Restrict Quality Observatory INSERT policies to service_role (security hardening).
--
-- Background:
--   Supabase advisor 0024_permissive_rls_policy flagged 3 INSERT policies on the
--   Quality Observatory tables as permissive: they were live as
--   `TO public WITH CHECK (true)`, allowing anon/authenticated clients to insert
--   arbitrary audit/scan/test-report rows.
--
-- Root cause (drift, not design):
--   The canonical table-creation migration (20260331100000_quality_observatory_tables.sql)
--   correctly declared `FOR INSERT TO service_role WITH CHECK (true)`. However the
--   live DB was provisioned 2026-03-31 via the Dashboard SQL Editor from an earlier
--   draft of that script that omitted the `TO service_role` clause -> the policy
--   defaulted to `TO public`.
--
-- Safety:
--   All writers (rotifer-dev / rotifer-playground / rotifer-admin / rotifer-mcp-server CI)
--   POST with QUALITY_SUPABASE_SERVICE_KEY (service_role). service_role BYPASSES RLS,
--   so restoring `TO service_role` does NOT affect any legitimate write path; it only
--   removes the anon/authenticated insert grant. This is a tightening-only change
--   and matches the canonical migration's intent.
--
-- Ref: Supabase database-linter 0024_permissive_rls_policy

ALTER POLICY "service_write_test_reports"   ON public.release_test_reports  TO service_role;
ALTER POLICY "service_write_security_scans" ON public.security_scan_results TO service_role;
ALTER POLICY "service_write_dep_audits"     ON public.dependency_audit_logs TO service_role;
