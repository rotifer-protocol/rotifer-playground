-- admin_audit_log — append-only record of every write action taken through
-- rotifer-admin's API surface, and every attempt that was refused.
--
-- Why this exists: a 2026 security review flagged the admin panel as having no
-- audit trail, and it stayed unscheduled on the reasoning that a single
-- operator leaves nothing for an audit log to disambiguate. That reasoning is
-- too narrow. A single operator still needs (a) to recall what they themselves
-- did months later, and (b) a trace if their session is ever stolen — under a
-- stolen session the attacker *is* the single operator, and only an audit
-- trail shows that it happened at all.
--
-- Two roles, deliberately split, both NOLOGIN (PostgREST switches into them via
-- a JWT role claim; neither can log in directly):
--
--   admin_auditor      INSERT only. Cannot read, update or delete — not even the
--                      rows it wrote. A leaked writer token can forge entries
--                      (visibly) but cannot exfiltrate the history, and cannot
--                      erase its own tracks. That non-erasability is the whole
--                      reason this table lives in Postgres rather than in
--                      Cloudflare D1/KV, where the Worker holds full rights.
--   admin_audit_reader SELECT only, for the dashboard's read proxy. Same shape
--                      as the admin_reader role on the RAG project.
--
-- Deliberately NOT readable by the quality project's public anon key: rows carry
-- admin email addresses and IP hashes, and a key shipped to every browser is
-- the wrong thing to gate them behind. Do not add an anon policy here.
--
-- Add-only: CREATE TABLE/INDEX IF NOT EXISTS, role existence checked before
-- CREATE ROLE (Postgres has no IF NOT EXISTS there), DROP POLICY IF EXISTS
-- immediately followed by CREATE POLICY (no CREATE POLICY IF NOT EXISTS either).

create table if not exists public.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default now(),
  -- Who: the verified admin email, or 'automation' for ADMIN_API_SECRET calls,
  -- or 'anonymous' when the request never got past authentication.
  actor        text not null,
  actor_kind   text not null check (actor_kind in ('admin', 'automation', 'anonymous')),
  -- What: coarse action name, e.g. 'github.workflow_dispatch', 'deck.token_create'.
  action       text not null,
  -- Which object: repo/workflow path, or deck token id. Never request bodies —
  -- deck token notes carry investor names, and an audit log must not become a
  -- second copy of the sensitive data it is auditing.
  target       text,
  http_method  text not null,
  path         text not null,
  status       integer not null,
  outcome      text not null check (outcome in ('allowed', 'denied')),
  ip_hash      text,
  user_agent   text
);

create index if not exists idx_admin_audit_occurred on public.admin_audit_log (occurred_at desc);
create index if not exists idx_admin_audit_actor    on public.admin_audit_log (actor, occurred_at desc);
create index if not exists idx_admin_audit_outcome  on public.admin_audit_log (outcome, occurred_at desc);

alter table public.admin_audit_log enable row level security;

do $$
begin
  if not exists (select from pg_roles where rolname = 'admin_auditor') then
    create role admin_auditor nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'admin_audit_reader') then
    create role admin_audit_reader nologin;
  end if;
end
$$;

-- PostgREST connects as `authenticator` and SET ROLEs into the JWT's role claim;
-- without membership that switch fails outright.
grant admin_auditor      to authenticator;
grant admin_audit_reader to authenticator;

grant insert on table public.admin_audit_log to admin_auditor;
grant select on table public.admin_audit_log to admin_audit_reader;

drop policy if exists "admin_audit_log_auditor_insert" on public.admin_audit_log;
create policy "admin_audit_log_auditor_insert" on public.admin_audit_log
  for insert to admin_auditor with check (true);

drop policy if exists "admin_audit_log_reader_select" on public.admin_audit_log;
create policy "admin_audit_log_reader_select" on public.admin_audit_log
  for select to admin_audit_reader using (true);

comment on table public.admin_audit_log is
  'Append-only audit trail of rotifer-admin write actions and refused attempts. Written by admin_auditor (INSERT only), read by admin_audit_reader (SELECT only); no anon access by design.';
