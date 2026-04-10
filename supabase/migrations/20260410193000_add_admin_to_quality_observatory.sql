-- Allow rotifer-admin CI reports to write into the shared quality observatory.
alter table public.release_test_reports
  drop constraint if exists release_test_reports_component_check;

alter table public.release_test_reports
  add constraint release_test_reports_component_check
  check (
    component = any (
      array[
        'cli'::text,
        'mcp'::text,
        'vscode'::text,
        'website'::text,
        'admin'::text,
        'contracts'::text,
        'worker'::text
      ]
    )
  );
