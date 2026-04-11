-- Add source-level release line semantics to the shared quality observatory.
alter table public.release_test_reports
  add column if not exists release_line_version text;

alter table public.security_scan_results
  add column if not exists release_line_version text;

alter table public.dependency_audit_logs
  add column if not exists release_line_version text;

create index if not exists idx_rtr_release_line_version
  on public.release_test_reports (release_line_version);

create index if not exists idx_ssr_release_line_version
  on public.security_scan_results (release_line_version);

create index if not exists idx_dal_release_line_version
  on public.dependency_audit_logs (release_line_version);

with release_anchors as (
  select
    case
      when version like 'v%' then version
      else 'v' || version
    end as release_line_version,
    max(created_at) as anchor_created_at
  from public.release_test_reports
  where component in ('cli', 'mcp', 'vscode', 'contracts', 'worker')
  group by 1
),
backfill_release_test_reports as (
  select
    report.id,
    coalesce(
      case
        when report.component in ('cli', 'mcp', 'vscode', 'contracts', 'worker') then
          case
            when report.version like 'v%' then report.version
            else 'v' || report.version
          end
        when exists (
          select 1
          from release_anchors anchor
          where anchor.release_line_version = case
            when report.version like 'v%' then report.version
            else 'v' || report.version
          end
        ) then
          case
            when report.version like 'v%' then report.version
            else 'v' || report.version
          end
        else (
          select anchor.release_line_version
          from release_anchors anchor
          order by
            abs(extract(epoch from (anchor.anchor_created_at - report.created_at))) asc,
            anchor.anchor_created_at desc,
            anchor.release_line_version desc
          limit 1
        )
      end,
      case
        when report.version like 'v%' then report.version
        else 'v' || report.version
      end
    ) as next_release_line_version
  from public.release_test_reports report
  where report.release_line_version is null
)
update public.release_test_reports report
set release_line_version = backfill.next_release_line_version
from backfill_release_test_reports backfill
where report.id = backfill.id
  and report.release_line_version is null;

with release_anchors as (
  select
    release_line_version,
    max(created_at) as anchor_created_at
  from public.release_test_reports
  where release_line_version is not null
    and component in ('cli', 'mcp', 'vscode', 'contracts', 'worker')
  group by release_line_version
),
backfill_security_scan_results as (
  select
    scan.id,
    coalesce(
      case
        when scan.component in ('cli', 'mcp', 'vscode', 'contracts', 'worker') then
          case
            when scan.version like 'v%' then scan.version
            else 'v' || scan.version
          end
        when exists (
          select 1
          from release_anchors anchor
          where anchor.release_line_version = case
            when scan.version like 'v%' then scan.version
            else 'v' || scan.version
          end
        ) then
          case
            when scan.version like 'v%' then scan.version
            else 'v' || scan.version
          end
        else (
          select anchor.release_line_version
          from release_anchors anchor
          order by
            abs(extract(epoch from (anchor.anchor_created_at - scan.created_at))) asc,
            anchor.anchor_created_at desc,
            anchor.release_line_version desc
          limit 1
        )
      end,
      case
        when scan.version like 'v%' then scan.version
        else 'v' || scan.version
      end
    ) as next_release_line_version
  from public.security_scan_results scan
  where scan.release_line_version is null
)
update public.security_scan_results scan
set release_line_version = backfill.next_release_line_version
from backfill_security_scan_results backfill
where scan.id = backfill.id
  and scan.release_line_version is null;

with release_anchors as (
  select
    release_line_version,
    max(created_at) as anchor_created_at
  from public.release_test_reports
  where release_line_version is not null
    and component in ('cli', 'mcp', 'vscode', 'contracts', 'worker')
  group by release_line_version
),
backfill_dependency_audit_logs as (
  select
    audit.id,
    (
      select anchor.release_line_version
      from release_anchors anchor
      order by
        abs(extract(epoch from (anchor.anchor_created_at - audit.created_at))) asc,
        anchor.anchor_created_at desc,
        anchor.release_line_version desc
      limit 1
    ) as next_release_line_version
  from public.dependency_audit_logs audit
  where audit.release_line_version is null
)
update public.dependency_audit_logs audit
set release_line_version = backfill.next_release_line_version
from backfill_dependency_audit_logs backfill
where audit.id = backfill.id
  and audit.release_line_version is null
  and backfill.next_release_line_version is not null;
