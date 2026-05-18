-- Sprint C Phase 6a — downloads RLS hardening (forward-compat patch)
--
-- Partial supersedence of the never-applied 20260331130000_rls_tightening_v081.sql.
-- Only the `downloads` table portion is migrated here. The `arena_entries` portion
-- of the original file (lock-down to service_role) is DEFERRED to a later v0.9.x
-- patch because CLI / MCP publish flow currently writes arena_entries directly
-- with user JWT — locking it down requires first wrapping arena INSERT into a
-- SECURITY DEFINER RPC. Out of Sprint C scope.
--
-- MCP-verified pre-conditions (2026-05-18):
--   - All known clients (rotifer-playground CLI, rotifer-mcp-server, websites)
--     ALREADY use `track_download(p_gene_id, p_source)` RPC, never direct INSERT
--     into downloads table. Cross-client grep confirmed zero direct INSERTs.
--   - track_download is SECURITY DEFINER → bypasses RLS, will continue to work
--     after this RLS hardening.
--   - The `/rest/v1/downloads` POST attack vector documented in
--     supabase-security-audit-prep.md §3.14 P0#3 (anonymous download-count
--     inflation) is the exact vector this migration closes.
--
-- Net effect: ANY future direct INSERT INTO downloads via PostgREST will be
-- rejected (no INSERT policy will match). track_download() RPC remains the
-- ONLY supported write path.
--
-- Reference: meta-lesson S2-L11 (private; 2026-05-18; dev/prod parity sprint),
--            Sprint C plan §2 Phase 6a, supabase-security-audit-prep §3.14 P0#3

-- Drop old permissive INSERT policy that allowed any authenticated user
-- to write any download record (download-count inflation vector).
DROP POLICY IF EXISTS "Authenticated users can log downloads" ON public.downloads;
DROP POLICY IF EXISTS "Anyone can log downloads" ON public.downloads;

-- Replace with deny-all INSERT policy. track_download() RPC (SECURITY
-- DEFINER) bypasses RLS and remains the only write path.
DROP POLICY IF EXISTS "No direct inserts on downloads" ON public.downloads;
CREATE POLICY "No direct inserts on downloads"
  ON public.downloads FOR INSERT
  WITH CHECK (false);
