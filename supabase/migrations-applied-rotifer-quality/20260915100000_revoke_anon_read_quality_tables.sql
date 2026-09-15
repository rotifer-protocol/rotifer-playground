-- rotifer-admin security audit 2026-09-02 #8, closing follow-up.
-- Prerequisite (done, verified): rotifer-admin reads these four tables
-- through /api/quality-data using quality_reader (PR #142, merged and
-- deployed 2026-09-15; live check confirmed the Quality Observatory card
-- renders real data — v0.26.0, 2,847 tests — through the new path).
--
-- These four SELECT policies are the only thing that made
-- release_test_reports / security_scan_results / dependency_audit_logs /
-- release_manifests world-readable: anyone holding the project's public
-- anon key (which ships in rotifer-admin's built JS bundle, and in CI
-- workflow files before today) could read all of it. quality_reader now
-- covers every legitimate read; nothing else should still be using anon
-- to read these tables directly (verified: no `PUBLIC_QUALITY_SUPABASE_*`
-- reference remains in rotifer-admin's src/ or functions/ after PR #142).
--
-- release_test_reports wasn't in the audit's own #8 bullet (only
-- security_scan_results / dependency_audit_logs / release_manifests were
-- named) but carries the identical anon_read_test_reports policy and is
-- read through the same proxy now — dropping it too rather than leaving
-- one of the four tables half-fixed.
--
-- Each DROP POLICY IF EXISTS is safe to run standalone or replay; RLS
-- stays enabled on all four tables (already true — see each table's own
-- creation migration), so once these policies are gone anon/authenticated
-- SELECT returns zero rows rather than erroring (RLS-enabled-zero-policy
-- is a silent empty result, not a permission error — verified pattern
-- from the RAG project's equivalent close, audit #10).

DROP POLICY IF EXISTS anon_read_test_reports ON public.release_test_reports;
DROP POLICY IF EXISTS anon_read_security_scans ON public.security_scan_results;
DROP POLICY IF EXISTS anon_read_dep_audits ON public.dependency_audit_logs;
DROP POLICY IF EXISTS anon_read_release_manifests ON public.release_manifests;

-- Verification (zero side effects, run with the anon key):
--   SELECT count(*) FROM release_test_reports;    -- 0 rows (was hundreds)
--   SELECT count(*) FROM security_scan_results;    -- 0 rows (was 616)
--   SELECT count(*) FROM dependency_audit_logs;     -- 0 rows (was 208)
--   SELECT count(*) FROM release_manifests;         -- 0 rows
-- And with the quality_reader token (Authorization: Bearer <jwt>,
-- apikey: <anon key>): the same four SELECTs return real rows, unchanged.
