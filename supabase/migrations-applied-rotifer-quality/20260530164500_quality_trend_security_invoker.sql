-- Make v_quality_trend respect the querying user's RLS (security hardening).
--
-- Supabase advisor 0010_security_definer_view flagged public.v_quality_trend:
-- without security_invoker, the view runs with the creator's privileges and
-- bypasses the querying user's RLS.
--
-- The view aggregates release_test_reports GROUP BY version, component.
-- release_test_reports has a public SELECT policy (anon_read_test_reports,
-- USING true), so anon already has RLS read access to every row the view
-- exposes. Flipping to security_invoker is behavior-equivalent for current
-- readers and strictly safer (the view now honors RLS).
--
-- Ref: Supabase database-linter 0010_security_definer_view

ALTER VIEW public.v_quality_trend SET (security_invoker = on);
