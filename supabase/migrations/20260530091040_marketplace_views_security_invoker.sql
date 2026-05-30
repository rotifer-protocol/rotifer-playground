-- Make 3 published-data views respect the querying user's RLS (security hardening).
--
-- Supabase advisor 0010_security_definer_view flagged arena_history,
-- v_polyglot_genes_by_language, and v_polyglot_metrics: without security_invoker,
-- a view runs with its creator's privileges and bypasses the querying user's RLS.
--
-- All three read only published-public data:
--   arena_history                 -> arena_entries (public read) + genes (published public read)
--   v_polyglot_genes_by_language  -> genes (published public read)
--   v_polyglot_metrics            -> genes (published public read) + profiles (public read)
-- The anon role already has RLS SELECT access to every row these views expose, so
-- flipping to security_invoker is behavior-equivalent for current readers and strictly
-- safer (the views now honor RLS). Post-change row counts unchanged (arena_history=104,
-- polyglot views=1 each); advisor 0010 ERRORs cleared (main DB now 0 ERROR-level lints).
--
-- Applied to the marketplace DB via Supabase MCP apply_migration on 2026-05-30.
-- Ref: Supabase database-linter 0010_security_definer_view

ALTER VIEW public.arena_history SET (security_invoker = on);
ALTER VIEW public.v_polyglot_genes_by_language SET (security_invoker = on);
ALTER VIEW public.v_polyglot_metrics SET (security_invoker = on);
