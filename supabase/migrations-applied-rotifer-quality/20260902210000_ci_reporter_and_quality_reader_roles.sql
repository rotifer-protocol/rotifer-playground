-- DRAFT for owner review — rotifer-admin security audit 2026-09-02, items #5 and #8.
-- Add-only: two new NOLOGIN roles with the narrowest grants that cover what
-- the two callers actually do. Nothing existing is dropped or narrowed here;
-- revoking the anon SELECT policies on the quality tables (#8) is a SEPARATE
-- follow-up that must land AFTER rotifer-admin reads them through a proxy
-- with quality_reader — same ship order as the RAG draft.

-- 2026-09-14 owner run: this script errored at the very last statement —
-- `relation "public.release_manifests" does not exist` (42P01). That table's
-- own migration (20260706120000_release_manifests.sql) was apparently never
-- actually applied here, despite being filed in this directory and despite
-- the 2026-09-02 audit describing it as a live, anon-readable table (audit
-- #8) — src/lib/api.ts's fetchQualityData() has been silently getting an
-- empty releaseManifests[] from rotifer-admin's dashboard this whole time
-- rather than erroring, which is why nobody noticed. Supabase's SQL Editor
-- runs a pasted script as one implicit transaction, so the ci_reporter /
-- quality_reader statements below rolled back with it — nothing from that
-- run persisted; this script is safe to run again from the top.
--
-- Fix: create the table here, add-only, idempotent. Deliberately WITHOUT
-- the anon-read policy the original 20260706120000 draft carried — the
-- entire point of today's work is to stop adding new anon-readable surface
-- on this project, not recreate it on a brand new table. quality_reader
-- (below) is this table's only intended read path; service_role keeps
-- write access exactly as the original draft specified.
create table if not exists public.release_manifests (
  id uuid primary key default gen_random_uuid(),
  release_line_version text not null,
  declared_at timestamptz not null default now(),
  expected_components text[] not null default array['cli', 'mcp', 'vscode', 'website', 'admin']::text[],
  npm_versions jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'reconciled')),
  reconciled_at timestamptz,
  notes text,
  release_pr_url text,
  constraint release_manifests_release_line_version_key unique (release_line_version)
);
create index if not exists idx_release_manifests_declared
  on public.release_manifests (declared_at desc);
comment on table public.release_manifests is 'Release-day manifest: expected quality observatory components per release line (ADR-312)';
alter table public.release_manifests enable row level security;
DROP POLICY IF EXISTS service_write_release_manifests ON public.release_manifests;
create policy service_write_release_manifests on public.release_manifests
  for insert to service_role with check (true);
DROP POLICY IF EXISTS service_update_release_manifests ON public.release_manifests;
create policy service_update_release_manifests on public.release_manifests
  for update to service_role using (true) with check (true);

-- #5 — CI reporter. rotifer-admin's ci.yml (and the sibling repos' CI) only
-- ever INSERTs one row into each of three tables, yet it has been doing so
-- with the project's service_role key. A leaked CI token would then also be
-- able to delete admin_audit_log — the exact thing that trail exists to
-- survive. This role can insert into exactly those three tables and do
-- nothing else, not even read them back.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_reporter') THEN
    CREATE ROLE ci_reporter NOLOGIN;
  END IF;
END $$;
GRANT ci_reporter TO authenticator;
GRANT USAGE ON SCHEMA public TO ci_reporter;
GRANT INSERT ON public.release_test_reports    TO ci_reporter;
GRANT INSERT ON public.security_scan_results   TO ci_reporter;
GRANT INSERT ON public.dependency_audit_logs   TO ci_reporter;
DROP POLICY IF EXISTS ci_reporter_insert ON public.release_test_reports;
CREATE POLICY ci_reporter_insert ON public.release_test_reports  FOR INSERT TO ci_reporter WITH CHECK (true);
DROP POLICY IF EXISTS ci_reporter_insert ON public.security_scan_results;
CREATE POLICY ci_reporter_insert ON public.security_scan_results FOR INSERT TO ci_reporter WITH CHECK (true);
DROP POLICY IF EXISTS ci_reporter_insert ON public.dependency_audit_logs;
CREATE POLICY ci_reporter_insert ON public.dependency_audit_logs FOR INSERT TO ci_reporter WITH CHECK (true);

-- #8 — quality reader for rotifer-admin's server-side proxy. Today the
-- dashboard reads these four tables browser-side with the anon key, which is
-- why they are world-readable (616 scan results with vulnerable-package
-- lists, 208 dependency audits, release notes). Once rotifer-admin reads them
-- through a Pages Function with this role, the anon SELECT policies can go.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quality_reader') THEN
    CREATE ROLE quality_reader NOLOGIN;
  END IF;
END $$;
GRANT quality_reader TO authenticator;
GRANT USAGE ON SCHEMA public TO quality_reader;
GRANT SELECT ON public.release_test_reports  TO quality_reader;
GRANT SELECT ON public.security_scan_results TO quality_reader;
GRANT SELECT ON public.dependency_audit_logs TO quality_reader;
GRANT SELECT ON public.release_manifests     TO quality_reader;
DROP POLICY IF EXISTS quality_reader_select ON public.release_test_reports;
CREATE POLICY quality_reader_select ON public.release_test_reports  FOR SELECT TO quality_reader USING (true);
DROP POLICY IF EXISTS quality_reader_select ON public.security_scan_results;
CREATE POLICY quality_reader_select ON public.security_scan_results FOR SELECT TO quality_reader USING (true);
DROP POLICY IF EXISTS quality_reader_select ON public.dependency_audit_logs;
CREATE POLICY quality_reader_select ON public.dependency_audit_logs FOR SELECT TO quality_reader USING (true);
DROP POLICY IF EXISTS quality_reader_select ON public.release_manifests;
CREATE POLICY quality_reader_select ON public.release_manifests     FOR SELECT TO quality_reader USING (true);

-- After push, the owner mints two JWTs with the project's legacy JWT secret
-- (same procedure as admin_auditor / admin_audit_reader on 2026-09-02):
--   { "role": "ci_reporter" }    → GitHub secret QUALITY_CI_REPORTER_TOKEN (then ci.yml
--                                   switches to apikey=anon + Authorization=this, and
--                                   QUALITY_SUPABASE_SERVICE_KEY is rotated/removed)
--   { "role": "quality_reader" } → Cloudflare Pages secret QUALITY_READER_TOKEN
-- Verification (zero side effects): with the ci_reporter token, SELECT on any
-- of the three tables → 403/42501; INSERT {} → a NOT NULL error (not 42501).
-- With quality_reader: SELECT → rows; INSERT {} → 42501.
