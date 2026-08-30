-- ============================================================
-- Anonymous usage heartbeat (ADR-329).
--
-- gene_invocation_log says a Gene was called and by whom, but only for
-- signed-in users (ADR-316 D1: unauthenticated reporting is off by default).
-- That is correct and untouched — this migration does not change it. What
-- ADR-329 adds is a second, deliberately separate signal: "is anyone running
-- this at all, from which channel" — answerable without identity, so it can
-- be on by default without repeating the silent-by-default mistake ADR-316
-- was written to fix.
--
-- ------------------------------------------------------------
-- Why this is not a row in gene_invocation_log
-- ------------------------------------------------------------
-- ADR-329 D2 is explicit: the two must never merge. §9.7.1 promises that
-- ledger is publicly recomputable per-row-attributable — every row traces to
-- a caller_agent_id an operator can be held to. An anonymous, no-consent-
-- required event flowing into that ledger would dilute the one property that
-- makes the transparency claim mean something: every row can be contested.
-- Anonymous rows can't be contested by design — that's the whole point of
-- them — so they get their own table with their own, narrower promise:
-- aggregate counts, not individual accountability.
--
-- ------------------------------------------------------------
-- Why anon gets EXECUTE here when it does not on log_gene_invocation
-- ------------------------------------------------------------
-- This looks backwards next to migration 20260830000000, which spent a
-- comment block explaining why anon must NOT call the invocation RPCs. The
-- two tables have opposite jobs: gene_invocation_log's whole value is that
-- every row is attributable, so writing it anonymously would let anyone
-- forge unaccountable rows into the §33.4 metrics — that's the attack this
-- table's grant would enable on gene_invocation_log, and it's exactly the
-- capability this table is CREATED to give out. This table has no per-row
-- accountability to protect, because it never promised any: an unauthenticated
-- user is the majority of ADR-329's target audience.
-- The exposure this does need to bound: unlimited rows per machine_id, and
-- unlimited channel/version values arriving as free text. See the shape
-- CHECK and the day-bucketed UNIQUE below.
--
-- ------------------------------------------------------------
-- Why no direct SELECT for anyone, only a public aggregate view
-- ------------------------------------------------------------
-- machine_id is a random UUID with no identity behind it, but per-row
-- machine_id history is still more than the aggregate needs to answer "is
-- anyone using this, from where" — and ADR-329 D2's "aggregate counts are
-- public" is a promise about aggregates, not an argument for exposing raw
-- rows too. The narrower the exposed surface, the less there is to defend
-- later. usage_heartbeat_public below carries no machine_id column at all.
--
-- Additive only: two new tables' worth of surface (table + view), one new
-- function. Touches nothing existing.
-- ============================================================

BEGIN;

CREATE TABLE usage_heartbeat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Random per-install UUID minted client-side, never derived from hardware,
  -- path, or username (ADR-329 D1.2 — "auditably anonymous", not merely
  -- undisclosed). Not a foreign key to anything: there is nothing for it to
  -- identify.
  machine_id UUID NOT NULL,
  -- UTC calendar day the heartbeat was recorded for. Client and server must
  -- agree on "day" or the same install can double-count across a boundary;
  -- the RPC below computes this server-side rather than trusting a
  -- client-supplied date, so a wrong client clock can't skew it.
  day DATE NOT NULL,
  -- Same shape as gene_invocation_log.client_channel (migration
  -- 20260830000000) — `cli`, or `mcp:<host>`. Deliberately the same
  -- vocabulary: a dashboard comparing signed-in usage against anonymous
  -- reach should not have to reconcile two different channel grammars.
  channel TEXT NOT NULL,
  -- Client version at last report for that (machine, day, channel). Whatever
  -- the most recent report said — not append-only history. Version adoption
  -- speed is the only thing this answers; it does not need a full history to
  -- answer it.
  client_version TEXT,
  -- Locally aggregated count of Gene invocations that day, summed across
  -- however many times the client flushed (a long-lived MCP server may flush
  -- hourly; a CLI flushes once per run). Never per-call — see
  -- record_heartbeat's ON CONFLICT: repeated reports for the same
  -- (machine, day, channel) accumulate, they don't overwrite.
  invocation_count INTEGER NOT NULL DEFAULT 0 CHECK (invocation_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per install per day per channel. The RPC's ON CONFLICT target.
  UNIQUE (machine_id, day, channel)
);

ALTER TABLE usage_heartbeat
  ADD CONSTRAINT usage_heartbeat_channel_shape
  CHECK (channel ~ '^[a-z0-9_]{1,32}(:[a-z0-9_]{1,32})?$');

-- Loosely bounded, not a hard allowlist: a version string's shape varies
-- more than a channel's does (semver, git sha, "dev"), so this only rejects
-- what would be actively hostile to store — no control characters, bounded
-- length. Empty/NULL both mean "unknown", which is honest for a client that
-- didn't resolve its own version.
ALTER TABLE usage_heartbeat
  ADD CONSTRAINT usage_heartbeat_client_version_shape
  CHECK (client_version IS NULL OR (length(client_version) <= 64 AND client_version !~ '[\x00-\x1F]'));

CREATE INDEX idx_usage_heartbeat_day_channel ON usage_heartbeat(day, channel);

COMMENT ON TABLE usage_heartbeat IS
  'Anonymous daily usage signal (ADR-329). Never joined with gene_invocation_log — see ADR-329 D2. No per-row accountability is promised or possible; only usage_heartbeat_public''s aggregates are.';
COMMENT ON COLUMN usage_heartbeat.machine_id IS
  'Random UUID minted client-side at first run. Never derived from hardware, filesystem paths, or account identity.';

ALTER TABLE usage_heartbeat ENABLE ROW LEVEL SECURITY;
-- No policies granting direct table access to anyone — not even authenticated.
-- All reads and writes go through record_heartbeat() and the public view
-- below. RLS with zero permissive policies defaults to deny-all, which is
-- the point: this line exists so that forgetting to add a policy later
-- fails closed, not so that a policy is expected here.

-- ------------------------------------------------------------
-- Write path
-- ------------------------------------------------------------
CREATE FUNCTION record_heartbeat(
  p_machine_id UUID,
  p_channel TEXT,
  p_client_version TEXT,
  p_invocation_delta INTEGER
)
RETURNS VOID AS $$
BEGIN
  -- GREATEST(..., 0): a client cannot report a negative delta to erase
  -- another report's count. Not a security boundary against a hostile
  -- client forging its own machine_id's row (nothing stops that — the
  -- signal is opt-out telemetry, not an audited ledger) but it does stop a
  -- buggy client from corrupting its own history with an unsigned
  -- underflow, and it costs nothing to keep.
  INSERT INTO usage_heartbeat (machine_id, day, channel, client_version, invocation_count)
  VALUES (
    p_machine_id,
    (now() AT TIME ZONE 'utc')::date,
    p_channel,
    p_client_version,
    GREATEST(p_invocation_delta, 0)
  )
  ON CONFLICT (machine_id, day, channel) DO UPDATE SET
    invocation_count = usage_heartbeat.invocation_count + GREATEST(EXCLUDED.invocation_count, 0),
    client_version = EXCLUDED.client_version,
    updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

COMMENT ON FUNCTION record_heartbeat(UUID, TEXT, TEXT, INTEGER) IS
  'Records (or accumulates into) one machine''s daily heartbeat for a channel. Callable by anon by design — ADR-329''s target audience is unauthenticated users. Never link this grant pattern to log_gene_invocation''s — see the migration header for why they are opposite on purpose.';

REVOKE EXECUTE ON FUNCTION record_heartbeat(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_heartbeat(UUID, TEXT, TEXT, INTEGER) TO anon;
GRANT EXECUTE ON FUNCTION record_heartbeat(UUID, TEXT, TEXT, INTEGER) TO authenticated;

-- ------------------------------------------------------------
-- Read path — aggregates only (ADR-329 D2: "the aggregate itself is public")
-- ------------------------------------------------------------
CREATE VIEW usage_heartbeat_public AS
SELECT
  day,
  channel,
  count(DISTINCT machine_id) AS active_machines,
  sum(invocation_count) AS total_invocations
FROM usage_heartbeat
GROUP BY day, channel;

COMMENT ON VIEW usage_heartbeat_public IS
  'Public aggregate: daily active machines and invocation counts per channel. No machine_id column — this is the only anonymous read surface, by design (ADR-329 D2).';

GRANT SELECT ON usage_heartbeat_public TO anon, authenticated;

COMMIT;
