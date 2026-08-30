-- ============================================================
-- pgTAP tests for anonymous usage heartbeat (ADR-329)
-- File: supabase/tests/anonymous_usage_heartbeat.sql
-- ============================================================
--
-- Regression for migration 20260830010000. What breaks here breaks silently,
-- same failure mode as every other reporting path in this schema (ADR-319,
-- ADR-322): reporting is fire-and-forget, so a wrong grant, a wrong upsert
-- target, or a leaked machine_id column would ship without a single error
-- anywhere a human would see it.
--
-- T1-T5:   the accumulation semantics (repeated reports add, they don't
--          overwrite; different channels/days don't bleed into each other).
-- T6-T7:   the shape constraints on channel and client_version.
-- T8-T11:  the permission model — and it is the OPPOSITE of
--          log_gene_invocation's on purpose. anon MUST be able to write here
--          (that's the entire point of ADR-329); anon and authenticated alike
--          must NOT be able to read raw rows, only the public aggregate.
-- T12:     the aggregate view carries no machine_id column — not "empty for
--          this data", structurally absent.
--
-- Role is simulated with SET LOCAL ROLE, same shape as
-- arena_provenance_write_guard.sql.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(15);

-- ------------------------------------------------------------
-- T1-T5 — accumulation, not overwrite
-- ------------------------------------------------------------

SELECT lives_ok(
  $$ SELECT record_heartbeat('b1111111-1111-4111-8111-111111111111', 'cli', '0.22.0', 3) $$,
  'T1: first report for a (machine, day, channel) is accepted');

SELECT is(
  (SELECT invocation_count FROM usage_heartbeat
    WHERE machine_id = 'b1111111-1111-4111-8111-111111111111' AND channel = 'cli'),
  3,
  'T1b: count is 3 after the first report');

SELECT record_heartbeat('b1111111-1111-4111-8111-111111111111', 'cli', '0.22.1', 2);
SELECT is(
  (SELECT invocation_count FROM usage_heartbeat
    WHERE machine_id = 'b1111111-1111-4111-8111-111111111111' AND channel = 'cli'),
  5,
  'T2: a second same-day report for the same channel ADDS — 3+2=5, not overwritten to 2');
SELECT is(
  (SELECT client_version FROM usage_heartbeat
    WHERE machine_id = 'b1111111-1111-4111-8111-111111111111' AND channel = 'cli'),
  '0.22.1',
  'T2b: client_version reflects the most recent report, not the first');

-- T3 — a different channel on the same machine/day is a separate row, not
-- folded into the first (a machine running both CLI and MCP that day must
-- show both, not one overwriting the other).
SELECT record_heartbeat('b1111111-1111-4111-8111-111111111111', 'mcp:dsh', '0.17.0', 4);
SELECT is(
  (SELECT invocation_count FROM usage_heartbeat
    WHERE machine_id = 'b1111111-1111-4111-8111-111111111111' AND channel = 'cli'),
  5,
  'T3: the mcp:dsh report did not touch the cli row''s count');
SELECT is(
  (SELECT count(*)::int FROM usage_heartbeat WHERE machine_id = 'b1111111-1111-4111-8111-111111111111'),
  2,
  'T3b: two channels for one machine on one day are two rows');

-- T4 — a negative delta cannot be used to erase a prior report's count.
SELECT record_heartbeat('b1111111-1111-4111-8111-111111111111', 'cli', '0.22.1', -100);
SELECT is(
  (SELECT invocation_count FROM usage_heartbeat
    WHERE machine_id = 'b1111111-1111-4111-8111-111111111111' AND channel = 'cli'),
  5,
  'T4: a negative delta is floored to 0 by GREATEST — count stays at 5, not driven negative');

-- T5 — a different machine is a wholly separate row.
SELECT record_heartbeat('b2222222-2222-4222-8222-222222222222', 'cli', '0.22.0', 1);
SELECT is(
  (SELECT invocation_count FROM usage_heartbeat
    WHERE machine_id = 'b1111111-1111-4111-8111-111111111111' AND channel = 'cli'),
  5,
  'T5: a second machine''s report does not touch the first machine''s count');

-- ------------------------------------------------------------
-- T6-T7 — shape constraints
-- ------------------------------------------------------------

SELECT throws_ok(
  $$ SELECT record_heartbeat('b3333333-3333-4333-8333-333333333333', 'MCP:BadCase', '0.1.0', 1) $$,
  '23514',
  NULL,
  'T6: an uppercase channel is refused — same shape rule as gene_invocation_log.client_channel');

SELECT throws_ok(
  $$ SELECT record_heartbeat('b3333333-3333-4333-8333-333333333333', 'cli', repeat('x', 65), 1) $$,
  '23514',
  NULL,
  'T7: a client_version over the length bound is refused');

-- ------------------------------------------------------------
-- T8-T11 — permission model (deliberately opposite of log_gene_invocation)
-- ------------------------------------------------------------

SET LOCAL ROLE anon;

-- T8 — the whole point of ADR-329: anon MUST be able to report.
SELECT lives_ok(
  $$ SELECT record_heartbeat('b4444444-4444-4444-8444-444444444444', 'cli', '0.22.0', 1) $$,
  'T8: anon can call record_heartbeat — this is what ADR-316''s "unauthenticated default off" did not allow and ADR-329 exists to add');

-- T9 — anon can technically SELECT (Supabase's bootstrap grants table-level
-- SELECT to anon on every public-schema table; that grant is not this
-- migration's to revoke). What actually blocks exposure is RLS with zero
-- policies: the query runs, it just returns no rows. Verified against a row
-- that demonstrably exists (T8 just inserted one) — this is not "the table
-- happens to be empty", it is RLS filtering out a row anon has no policy for.
SELECT is(
  (SELECT count(*)::int FROM usage_heartbeat),
  0,
  'T9: anon''s query returns zero rows — RLS with no SELECT policy hides every row, not an exception, even though anon holds bare table-level SELECT');

-- T10 — anon CAN read the public aggregate.
SELECT lives_ok(
  $$ SELECT count(*) FROM usage_heartbeat_public $$,
  'T10: anon can read the public aggregate view');

RESET ROLE;

-- T11 — authenticated is equally blocked from raw rows. The aggregate-only
-- promise is not "anon-only opacity", it is nobody-reads-raw-rows.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a8111111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM usage_heartbeat),
  0,
  'T11: authenticated''s query returns zero rows too — the aggregate-only boundary applies to everyone, not anon-only opacity');
RESET ROLE;
RESET request.jwt.claims;

-- ------------------------------------------------------------
-- T12 — the aggregate view structurally cannot leak machine_id
-- ------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM information_schema.columns
    WHERE table_name = 'usage_heartbeat_public' AND column_name = 'machine_id'),
  0,
  'T12: usage_heartbeat_public has no machine_id column — not filtered out, structurally absent');

SELECT * FROM finish();

ROLLBACK;
