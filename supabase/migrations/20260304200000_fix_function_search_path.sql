-- ============================================================
-- Migration: Fix Function Search Path Mutable warnings
-- Rotifer Protocol v0.7
--
-- All functions with SECURITY DEFINER (or callable via PostgREST)
-- should have search_path explicitly set to prevent search path
-- hijacking attacks.
--
-- Supabase Security Advisor: 10 x "Function Search Path Mutable"
-- Fix: SET search_path = 'public' for all affected functions.
--
-- Using 'public' rather than '' because function bodies reference
-- tables by unqualified names (e.g. `genes` not `public.genes`).
-- This pins resolution to the public schema, preventing hijacking
-- via attacker-created schemas while keeping existing queries working.
-- ============================================================

BEGIN;

ALTER FUNCTION public.handle_new_user()
  SET search_path = 'public';

ALTER FUNCTION public.apply_reputation_decay()
  SET search_path = 'public';

ALTER FUNCTION public.match_documents(vector(1536), INT, FLOAT)
  SET search_path = 'public';

ALTER FUNCTION public.get_reputation_leaderboard(INTEGER)
  SET search_path = 'public';

ALTER FUNCTION public.update_dev_reputation_timestamp()
  SET search_path = 'public';

ALTER FUNCTION public.compute_developer_reputation(UUID)
  SET search_path = 'public';

ALTER FUNCTION public.get_gene_stats(UUID)
  SET search_path = 'public';

ALTER FUNCTION public.get_arena_rankings(TEXT, INT, INT)
  SET search_path = 'public';

ALTER FUNCTION public.compute_gene_reputation(UUID)
  SET search_path = 'public';

ALTER FUNCTION public.update_updated_at()
  SET search_path = 'public';

COMMIT;
