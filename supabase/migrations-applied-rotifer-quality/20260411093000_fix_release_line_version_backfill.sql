-- Prefer exact component-version matches when a historical row already lands on a known release line.
with release_anchors as (
  select distinct release_line_version
  from public.release_test_reports
  where release_line_version is not null
    and component in ('cli', 'mcp', 'vscode', 'contracts', 'worker')
),
exact_release_matches as (
  select
    report.id,
    case
      when report.version like 'v%' then report.version
      else 'v' || report.version
    end as exact_release_line_version
  from public.release_test_reports report
  where exists (
    select 1
    from release_anchors anchor
    where anchor.release_line_version = case
      when report.version like 'v%' then report.version
      else 'v' || report.version
    end
  )
)
update public.release_test_reports report
set release_line_version = exact_match.exact_release_line_version
from exact_release_matches exact_match
where report.id = exact_match.id
  and report.release_line_version is distinct from exact_match.exact_release_line_version;

with release_anchors as (
  select distinct release_line_version
  from public.release_test_reports
  where release_line_version is not null
    and component in ('cli', 'mcp', 'vscode', 'contracts', 'worker')
),
exact_release_matches as (
  select
    scan.id,
    case
      when scan.version like 'v%' then scan.version
      else 'v' || scan.version
    end as exact_release_line_version
  from public.security_scan_results scan
  where exists (
    select 1
    from release_anchors anchor
    where anchor.release_line_version = case
      when scan.version like 'v%' then scan.version
      else 'v' || scan.version
    end
  )
)
update public.security_scan_results scan
set release_line_version = exact_match.exact_release_line_version
from exact_release_matches exact_match
where scan.id = exact_match.id
  and scan.release_line_version is distinct from exact_match.exact_release_line_version;
