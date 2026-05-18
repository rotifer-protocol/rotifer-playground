-- Quality Observatory tables for CI quality/security reporting
-- §3.8 P0#1: release_test_reports + security_scan_results + dependency_audit_logs

-- ============================================================
-- 1. release_test_reports — CI test result aggregation
-- ============================================================
CREATE TABLE IF NOT EXISTS release_test_reports (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  version     text NOT NULL,
  component   text NOT NULL CHECK (component IN ('cli', 'mcp', 'vscode', 'website', 'contracts', 'worker')),
  test_type   text NOT NULL DEFAULT 'unit' CHECK (test_type IN ('unit', 'integration', 'e2e', 'security')),
  total_tests integer NOT NULL DEFAULT 0 CHECK (total_tests >= 0),
  passed      integer NOT NULL DEFAULT 0 CHECK (passed >= 0),
  failed      integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped     integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  duration_ms integer DEFAULT 0 CHECK (duration_ms >= 0),
  coverage_pct numeric(5,2) CHECK (coverage_pct IS NULL OR (coverage_pct >= 0 AND coverage_pct <= 100)),
  ci_run_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rtr_version ON release_test_reports (version);
CREATE INDEX IF NOT EXISTS idx_rtr_component ON release_test_reports (component);
CREATE INDEX IF NOT EXISTS idx_rtr_created_at ON release_test_reports (created_at DESC);

-- ============================================================
-- 2. security_scan_results — V(g), gitleaks, cargo-audit, npm-audit
-- ============================================================
CREATE TABLE IF NOT EXISTS security_scan_results (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  version         text NOT NULL,
  component       text NOT NULL,
  scan_type       text NOT NULL CHECK (scan_type IN ('vg', 'gitleaks', 'cargo_audit', 'npm_audit', 'slither', 'dependency')),
  grade           text CHECK (grade IN ('A', 'B', 'C', 'D', 'F', 'PASS', 'FAIL')),
  severity_counts jsonb NOT NULL DEFAULT '{}',
  findings        jsonb DEFAULT '[]',
  source          text,
  ci_run_url      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ssr_version ON security_scan_results (version);
CREATE INDEX IF NOT EXISTS idx_ssr_component ON security_scan_results (component);
CREATE INDEX IF NOT EXISTS idx_ssr_created_at ON security_scan_results (created_at DESC);

-- ============================================================
-- 3. dependency_audit_logs — npm/cargo audit + Dependabot tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS dependency_audit_logs (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  component       text NOT NULL,
  audit_tool      text NOT NULL CHECK (audit_tool IN ('npm_audit', 'cargo_audit', 'dependabot', 'slither')),
  total_deps      integer DEFAULT 0,
  vulnerabilities jsonb NOT NULL DEFAULT '{"critical":0,"high":0,"moderate":0,"low":0}',
  advisories      jsonb DEFAULT '[]',
  ci_run_url      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dal_component ON dependency_audit_logs (component);
CREATE INDEX IF NOT EXISTS idx_dal_created_at ON dependency_audit_logs (created_at DESC);

-- ============================================================
-- RLS: CI writes via service_role, Admin reads via anon
-- ============================================================
ALTER TABLE release_test_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE dependency_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_test_reports" ON release_test_reports
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "service_write_test_reports" ON release_test_reports
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "anon_read_security_scans" ON security_scan_results
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "service_write_security_scans" ON security_scan_results
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "anon_read_dep_audits" ON dependency_audit_logs
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "service_write_dep_audits" ON dependency_audit_logs
  FOR INSERT TO service_role WITH CHECK (true);
