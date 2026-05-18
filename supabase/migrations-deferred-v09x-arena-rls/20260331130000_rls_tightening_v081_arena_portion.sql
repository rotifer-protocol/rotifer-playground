-- §3.14 P0#3: Lock down direct INSERT on downloads table
-- Downloads should only happen via track_download() SECURITY DEFINER function.
-- Direct client INSERT is no longer permitted.
DROP POLICY IF EXISTS "Authenticated users can log downloads" ON downloads;
DROP POLICY IF EXISTS "Anyone can log downloads" ON downloads;

CREATE POLICY "No direct inserts on downloads"
  ON downloads FOR INSERT
  WITH CHECK (false);

-- §3.14 P0#3: Restrict arena_entries INSERT/UPDATE to service_role
-- Arena entries are created by the CLI publish flow, not directly by users.
-- Read access remains open for leaderboard visibility.
DROP POLICY IF EXISTS "Authenticated users can submit to arena" ON arena_entries;
DROP POLICY IF EXISTS "Arena submissions by authenticated" ON arena_entries;

CREATE POLICY "Arena entries managed by service role only"
  ON arena_entries FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS "Gene owners can update arena entries" ON arena_entries;

CREATE POLICY "Arena entry updates by service role only"
  ON arena_entries FOR UPDATE
  USING (false)
  WITH CHECK (false);
