-- Fix update_arena_total_calls(): it compared arena_entries.gene_id (uuid) with
-- mcp_call_log.gene_id (text) without a cast.
--
-- Postgres has no implicit text -> uuid cast, so `WHERE gene_id = NEW.gene_id`
-- raises `operator does not exist: uuid = text` the moment a call log carries a
-- gene id. The trigger runs AFTER INSERT on mcp_call_log, so the exception
-- aborts the INSERT itself: every log_mcp_call() with a non-null p_gene_id has
-- failed since the trigger shipped (20260518173918), and arena_entries.total_calls
-- never moved. Clients call log_mcp_call() fire-and-forget and swallow the 400,
-- which is why nobody saw it. Rows with a NULL gene_id took the IF-guard's other
-- branch and inserted fine, so the table looked alive.
--
-- Two things at once:
--   1. Cast, so a real id increments the counter again.
--   2. Only cast when the text is uuid-shaped. Older MCP servers reported the
--      Gene's *directory name* here (rotifer-mcp-server <= 0.16.0); a name is
--      not an id, must not abort the insert, and must not increment anything.
--
-- Schema-only (CREATE OR REPLACE, signature and trigger binding unchanged).
-- Companion: rotifer-mcp-server PR #114 stops sending names in the first place.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_arena_total_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF NEW.gene_id IS NOT NULL
     AND NEW.gene_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    UPDATE arena_entries
    SET total_calls = total_calls + 1
    WHERE gene_id = NEW.gene_id::uuid;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.update_arena_total_calls() IS
  'mcp_call_log AFTER INSERT: increments arena_entries.total_calls when gene_id is a uuid; '
  'ignores NULL and non-uuid values (older clients sent directory names). '
  'Fixed 2026-08-15: previously compared uuid = text without a cast and aborted every gene-tagged insert.';

COMMIT;
