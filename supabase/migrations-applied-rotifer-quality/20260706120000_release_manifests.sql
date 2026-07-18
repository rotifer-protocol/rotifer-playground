-- Release manifests — declare expected components per release line (ADR-312 P4).
-- Run in Quality Observatory Supabase project (same as release_test_reports).

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

create policy "anon_read_release_manifests" on public.release_manifests
  for select using (true);

create policy "service_write_release_manifests" on public.release_manifests
  for insert to service_role with check (true);

create policy "service_update_release_manifests" on public.release_manifests
  for update to service_role using (true) with check (true);
