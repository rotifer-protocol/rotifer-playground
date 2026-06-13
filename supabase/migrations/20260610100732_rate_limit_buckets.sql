-- ============================================================
-- 20260610100732 — rate_limit_buckets (parity backfill)
--
-- The rate_limit_buckets table + rate_limit_consume/cleanup functions were
-- applied to production via the Supabase Dashboard during the v0.9.1 §3.5
-- rate-limit work (~2026-06-10), but never entered this timestamp migration
-- chain and schema_migrations had no record. A 2026-06-12 production probe
-- confirmed all three objects exist with no ledger record — this file backfills
-- the chain so from-scratch CI replay stays self-consistent. version = the
-- rate-limit work completion anchor.
--
-- DORMANT: runtime rate limiting now runs on Cloudflare Durable Objects; this
-- table/RPCs are no longer read at runtime. Retained under the append-only
-- migration policy. DDL is idempotent (CREATE IF NOT EXISTS / OR REPLACE;
-- idempotent REVOKE/GRANT) → replay-safe. The production ledger accounting
-- INSERT is a separate manual step.
-- ============================================================

BEGIN;

-- =====================
-- Table: rate_limit_buckets
--
-- bucket_key encodes scope:
--   ip:<sha256-hash-hex>                          (global per-IP)
--   user:<user-uuid>                              (per-authenticated-user)
--   chat:agent:<agent-id>:ip:<sha256-hash-hex>    (per-Agent per-anon-IP)
--   chat:agent:<agent-id>:user:<user-uuid>        (per-Agent per-user, paid tier)
--   chat:agent:<agent-id>:global                  (per-Agent global防刷)
--
-- window_start: timestamp truncated to the configured window size (minute,
-- hour, etc.). Primary key prevents duplicate counters within a window.
-- =====================

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key       TEXT        NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  count            INTEGER     NOT NULL DEFAULT 0,
  last_increment   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bucket_key, window_start)
);

-- Index for the cleanup query (delete-old-rows scan)
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_idx
  ON rate_limit_buckets (window_start);

COMMENT ON TABLE rate_limit_buckets IS
  'Supabase-backed rate limit counters (v0.9.1 §3.5). All access via rate_limit_consume() RPC.';

-- =====================
-- RPC: rate_limit_consume
--
-- Atomic upsert + increment + threshold check. Returns whether the request is
-- allowed and how many calls remain in the current window.
--
-- Idempotency: each call increments exactly once (race-safe via INSERT ON
-- CONFLICT DO UPDATE).
--
-- SECURITY DEFINER: the RPC runs as the function owner, bypassing RLS on the
-- underlying table. Direct table access is denied for everyone (see policies
-- below). This is the only sanctioned write path.
-- =====================

CREATE OR REPLACE FUNCTION rate_limit_consume(
  p_bucket_key   TEXT,
  p_window_start TIMESTAMPTZ,
  p_max          INTEGER
) RETURNS TABLE (
  allowed       BOOLEAN,
  current_count INTEGER,
  max_allowed   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO rate_limit_buckets (bucket_key, window_start, count, last_increment)
  VALUES (p_bucket_key, p_window_start, 1, NOW())
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET
    count = rate_limit_buckets.count + 1,
    last_increment = NOW()
  RETURNING rate_limit_buckets.count INTO v_count;

  RETURN QUERY SELECT (v_count <= p_max), v_count, p_max;
END;
$$;

COMMENT ON FUNCTION rate_limit_consume(TEXT, TIMESTAMPTZ, INTEGER) IS
  'Atomic increment + threshold check for rate_limit_buckets. Returns (allowed, count, max).';

-- =====================
-- RPC: rate_limit_cleanup
--
-- Garbage-collect stale buckets older than the retention window (default 24h).
-- Intended to be called periodically (cron / scheduled trigger). Anonymous /
-- authenticated users cannot call this; service role only.
-- =====================

CREATE OR REPLACE FUNCTION rate_limit_cleanup(
  p_older_than INTERVAL DEFAULT INTERVAL '24 hours'
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM rate_limit_buckets
  WHERE window_start < (NOW() - p_older_than);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION rate_limit_cleanup(INTERVAL) IS
  'Garbage-collect rate_limit_buckets rows older than the given interval.';

-- =====================
-- RLS — deny all direct access; force RPC use
-- =====================

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- No INSERT / UPDATE / SELECT / DELETE policies = nobody can do these
-- via PostgREST. Only SECURITY DEFINER RPCs (which run as table owner)
-- can touch the data. This is the strictest stance — appropriate because
-- the table contains rate-limit accounting that should never be tampered
-- with from the client.

-- Revoke RPC execute (Plan §4 + rotifer-security-config-safety rule: clients
-- should hit middleware-side enforcement, not the RPC).
--
-- IMPORTANT (issue #18 follow-up): in Postgres, EXECUTE is granted to PUBLIC by
-- default, and Supabase additionally gives anon/authenticated an explicit grant.
-- Revoking only anon/authenticated (as the first draft of this migration did) is
-- INSUFFICIENT — every role still reaches these functions via the PUBLIC grant.
-- The complete lockdown (mirroring migrations 005/006) is: REVOKE FROM PUBLIC +
-- FROM anon + FROM authenticated, then GRANT back ONLY to service_role so the
-- edge limiter (Cloudflare, authenticating with the service/secret key) is the
-- sole sanctioned caller. After REVOKE FROM PUBLIC, service_role no longer
-- inherits execute implicitly, so the explicit GRANT below is required.
REVOKE EXECUTE ON FUNCTION rate_limit_consume(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rate_limit_consume(TEXT, TIMESTAMPTZ, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION rate_limit_consume(TEXT, TIMESTAMPTZ, INTEGER) FROM authenticated;
REVOKE EXECUTE ON FUNCTION rate_limit_cleanup(INTERVAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rate_limit_cleanup(INTERVAL) FROM anon;
REVOKE EXECUTE ON FUNCTION rate_limit_cleanup(INTERVAL) FROM authenticated;

GRANT EXECUTE ON FUNCTION rate_limit_consume(TEXT, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION rate_limit_cleanup(INTERVAL) TO service_role;

COMMIT;

-- ============================================================
-- Notes for callers (functions/lib/rate-limit.ts):
--
-- 1. Use Supabase service_role key (NOT anon key) in CF Worker env to call
--    rate_limit_consume. The anon key cannot execute the RPC per the REVOKE
--    statements above.
--
-- 2. Compute window_start by truncating NOW() to the configured granularity:
--      const min = new Date(Date.now() - (Date.now() % 60_000));   // per-min
--      const hour = new Date(Date.now() - (Date.now() % 3_600_000)); // per-hour
--    Pass as ISO string to PostgREST.
--
-- 3. IP hashing: SHA-256 of `cf-connecting-ip` header value. Truncate to first
--    16 hex chars for compactness (still 64 bits of collision space — fine for
--    rate limiting buckets).
--
-- 4. Test environment: keep limits as-is but seed isolated bucket_keys with
--    a test-only prefix (e.g. `test:ip:...`) so production buckets are never
--    polluted by tests. Enforced in rate-limit.ts by an env flag.
-- ============================================================
