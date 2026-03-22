-- ============================================================
-- Migration: Fix arena_history view Security Definer
-- Rotifer Protocol v0.7
--
-- The arena_history view was created without security_invoker,
-- causing it to execute with the view owner's (postgres) privileges,
-- bypassing RLS on underlying tables (arena_entries, genes).
--
-- Supabase Security Advisor flagged this as an Error on 2026-03-01.
-- Fix: set security_invoker = true so queries respect the
-- calling user's RLS policies.
-- ============================================================

BEGIN;

CREATE OR REPLACE VIEW arena_history
WITH (security_invoker = true) AS
SELECT
  ae.gene_id,
  g.name AS gene_name,
  ae.domain,
  ae.fitness_value,
  ae.safety_score,
  ae.total_calls,
  ae.last_evaluated,
  ae.created_at
FROM arena_entries ae
JOIN genes g ON g.id = ae.gene_id
WHERE g.published = true
ORDER BY ae.last_evaluated DESC;

COMMIT;
