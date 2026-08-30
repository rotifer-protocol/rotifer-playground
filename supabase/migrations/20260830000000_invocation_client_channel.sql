-- ============================================================
-- Record which client reported each Gene invocation.
--
-- Today `gene_invocation_log` says a call happened and who made it, but not
-- what it came through. With the Gene entry points now spread across five
-- hosts (CLI, MCP under Cursor / Claude Code / OpenClaw, and since ADR-321 a
-- DSH bundle), "is anyone actually using this, and from where" cannot be
-- answered from the ledger — which is the question the channel column exists
-- to make answerable.
--
-- ------------------------------------------------------------
-- Why a v2 function instead of adding a parameter to the existing one
-- ------------------------------------------------------------
-- The obvious move — CREATE OR REPLACE with a third `DEFAULT NULL` parameter
-- — silently breaks every existing client. Measured on Postgres 17 before
-- writing this file, not reasoned about:
--
--   CREATE FUNCTION log_gene_invocation(uuid, text) ...              -- existing
--   CREATE FUNCTION log_gene_invocation(uuid, text, text DEFAULT NULL) ...
--   SELECT log_gene_invocation('...'::uuid, 'caller');
--   ERROR:  function log_gene_invocation(uuid, unknown) is not unique
--
-- Both candidates match a two-argument call and Postgres refuses to choose.
-- Every already-published CLI and MCP server would start failing that call —
-- and because reporting is fire-and-forget on both sides, the failure would
-- be silent, which is exactly how the pipeline this column serves went dead
-- for months in the first place (ADR-319).
--
-- Dropping the old signature and recreating it with the default argument does
-- work (also measured), but the migration rules forbid changing an RPC's
-- signature for precisely this class of reason, and a DROP would additionally
-- discard the function's grants — see the permissions note below.
--
-- So: the existing entry point keeps its exact signature, a v2 entry point
-- carries the new argument, and both delegate to one shared implementation so
-- the idempotency guard cannot drift between them. That last part matters
-- more than it looks: until ADR-322 D2 lands, a single MCP `run_gene` is
-- reported twice — once by the MCP server and once by the CLI it spawns — and
-- those two reports will now arrive at *different* entry points. A guard
-- living in only one of them would stop catching the pair it was written for.
--
-- ------------------------------------------------------------
-- Permissions
-- ------------------------------------------------------------
-- `log_gene_invocation` is currently executable by `authenticated` only:
-- 20260322120000 revoked it from PUBLIC/anon/authenticated, and 20260527020805
-- granted it back to authenticated alone. Postgres grants EXECUTE to PUBLIC by
-- default on every newly created function, so the new functions below must
-- repeat that revoke explicitly. Skipping it would let anyone holding the
-- public anon key write rows into the ledger that drives the §33.4
-- anti-manipulation metrics.
--
-- Additive only: one nullable column, one replaced function body (signature
-- untouched), two new functions. No data is read, moved, or deleted.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. The column
-- ------------------------------------------------------------
-- Nullable with no default. NULL is not "unknown pending backfill" here, it is
-- the permanent, honest value for every row written by a client that predates
-- this migration — including rows still being written today by installed CLIs
-- that will never be upgraded. ADR-322 D4 keeps history as it was recorded;
-- backfilling a guessed channel onto existing rows would be inventing data.
ALTER TABLE gene_invocation_log
  ADD COLUMN IF NOT EXISTS client_channel TEXT;

-- Shape, not vocabulary. The set of hosts changes faster than migrations ship
-- (DSH arrived in a week), so an enum or a CHECK IN (...) would guarantee that
-- the next host either gets rejected at the door or forces a schema change to
-- be reportable. What is constrained is what makes the column safe to group by
-- and safe to render: lowercase snake_case ASCII, optionally one colon to
-- qualify a transport with its host (`mcp:claude_code`), bounded length.
--
-- Lowercase-only is deliberate. The identifier-boundary rule exists because a
-- camelCase id met a `.toLowerCase()` on the way to a lookup and silently
-- stopped matching; a column that can hold both `DSH` and `dsh` would split
-- one host across two rows in every aggregate that follows.
ALTER TABLE gene_invocation_log
  ADD CONSTRAINT gene_invocation_log_client_channel_shape
  CHECK (
    client_channel IS NULL
    OR client_channel ~ '^[a-z0-9_]{1,32}(:[a-z0-9_]{1,32})?$'
  );

COMMENT ON COLUMN gene_invocation_log.client_channel IS
  'What the invocation was reported through: `cli`, or `mcp:<host>` (e.g. mcp:dsh, mcp:cursor). NULL for clients that predate the column — never backfilled, see ADR-322 D4. Not authoritative while ADR-322 D2 is open: an MCP call is reported by both the MCP server and the CLI it spawns, and the idempotency guard keeps whichever arrives first.';

-- ------------------------------------------------------------
-- 2. Shared implementation
-- ------------------------------------------------------------
-- The body is ADR-322 D1's guard, unchanged in behaviour, with the channel
-- threaded through the INSERT. Both entry points delegate here so there is one
-- window, one lock, one INSERT — defined once, next to the rule it enforces.
CREATE OR REPLACE FUNCTION log_gene_invocation_impl(
  p_gene_id UUID,
  p_caller_agent_id TEXT,
  p_client_channel TEXT
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Serialise concurrent reports for the same caller-gene pair, so the
  -- check-then-insert below cannot be raced. Transaction-scoped.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_gene_id::TEXT || ':' || p_caller_agent_id, 0)
  );

  SELECT id INTO v_id
    FROM gene_invocation_log
   WHERE gene_id = p_gene_id
     AND caller_agent_id = p_caller_agent_id
     AND invoked_at > now() - INTERVAL '5 seconds'
   ORDER BY invoked_at DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- Already recorded. Hand back the row that represents this call rather
    -- than NULL: the caller asked for its invocation to be logged, and it is.
    --
    -- The winning row keeps the channel it was written with. Deliberately not
    -- "upgrade NULL to the value the second reporter supplied": the two
    -- reports of one MCP call come from different processes with different
    -- views, and letting the loser overwrite the winner would make the stored
    -- channel depend on network timing. One call, one row, one channel —
    -- decided by whoever got there first, and documented as such on the column.
    RETURN v_id;
  END IF;

  INSERT INTO gene_invocation_log (gene_id, caller_agent_id, client_channel)
  VALUES (p_gene_id, p_caller_agent_id, p_client_channel)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION log_gene_invocation_impl(UUID, TEXT, TEXT) IS
  'Shared body for log_gene_invocation and log_gene_invocation_v2. Not granted to any client role — reach it through one of the two entry points.';

-- ------------------------------------------------------------
-- 3. Entry points
-- ------------------------------------------------------------
-- Existing signature, unchanged, so every published client keeps working
-- exactly as before and records a NULL channel.
CREATE OR REPLACE FUNCTION log_gene_invocation(
  p_gene_id UUID,
  p_caller_agent_id TEXT
)
RETURNS UUID AS $$
  SELECT log_gene_invocation_impl(p_gene_id, p_caller_agent_id, NULL);
$$ LANGUAGE sql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION log_gene_invocation(UUID, TEXT) IS
  'Records one Gene invocation with no channel attribution. Kept at its original signature for already-published clients; new clients should call log_gene_invocation_v2. Idempotent within 5 seconds per (gene, caller) — ADR-322 D1.';

CREATE OR REPLACE FUNCTION log_gene_invocation_v2(
  p_gene_id UUID,
  p_caller_agent_id TEXT,
  p_client_channel TEXT
)
RETURNS UUID AS $$
  SELECT log_gene_invocation_impl(p_gene_id, p_caller_agent_id, p_client_channel);
$$ LANGUAGE sql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION log_gene_invocation_v2(UUID, TEXT, TEXT) IS
  'Records one Gene invocation together with the channel it was reported through. Shares the ADR-322 D1 idempotency guard with log_gene_invocation — one call cannot be counted twice by arriving at two different entry points.';

-- ------------------------------------------------------------
-- 4. Permissions
-- ------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on creation; both new functions have to be
-- closed explicitly, or the public anon key gains write access to the ledger.
REVOKE EXECUTE ON FUNCTION log_gene_invocation_impl(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION log_gene_invocation_impl(UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION log_gene_invocation_impl(UUID, TEXT, TEXT) FROM authenticated;

REVOKE EXECUTE ON FUNCTION log_gene_invocation_v2(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION log_gene_invocation_v2(UUID, TEXT, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION log_gene_invocation_v2(UUID, TEXT, TEXT) TO authenticated;

-- CREATE OR REPLACE preserves an existing function's grants, so
-- log_gene_invocation keeps the authenticated grant from 20260527020805.
-- Restated here anyway: this migration is also what a fresh `db reset` replays,
-- and on that path the function is created by 20260322120000, revoked there,
-- and granted by 20260527020805 — leaving it correct either way. An explicit
-- grant costs nothing and removes the need to trace three files to know who
-- can call this.
GRANT EXECUTE ON FUNCTION log_gene_invocation(UUID, TEXT) TO authenticated;

COMMIT;
