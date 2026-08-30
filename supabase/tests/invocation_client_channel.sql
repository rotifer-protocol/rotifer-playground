-- ============================================================
-- pgTAP tests for the client_channel column and log_gene_invocation_v2
-- File: supabase/tests/invocation_client_channel.sql
-- ============================================================
--
-- Regression for migration 20260830000000. Three things can break here and all
-- three fail silently in production, because invocation reporting is
-- fire-and-forget on every client:
--
--   1. The old two-argument entry point stops resolving. Adding a third
--      parameter with a DEFAULT to the existing function does exactly this
--      ("function log_gene_invocation(uuid, unknown) is not unique") and every
--      already-published CLI and MCP server would stop reporting. T1-T3 pin
--      the old signature down.
--   2. The idempotency guard stops spanning both entry points. Until ADR-322
--      D2 lands, one MCP `run_gene` is reported twice — and after this
--      migration those two reports can arrive at *different* functions. T6/T7
--      are that exact pair.
--   3. The new function is left executable by PUBLIC. Postgres grants EXECUTE
--      to PUBLIC on every newly created function, so anyone holding the public
--      anon key could write rows into the ledger behind §33.4. T10-T12.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(16);

-- ------------------------------------------------------------
-- Fixture: one author, two published genes. Rolled back at the end.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('d1111111-1111-4111-8111-111111111111', 'channel-test@example.com',
        '{"user_name": "channel_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('d2222222-2222-4222-8222-222222222222',
        'd1111111-1111-4111-8111-111111111111',
        'channel-test-gene', 'test.channel', '0.1.0', 'Wrapped',
        '{"domain":"test.channel","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('e', 64)),
       ('d3333333-3333-4333-8333-333333333333',
        'd1111111-1111-4111-8111-111111111111',
        'channel-test-other', 'test.channel', '0.1.0', 'Wrapped',
        '{"domain":"test.channel","inputSchema":{},"outputSchema":{},"version":"0.2.0"}'::jsonb,
        true, repeat('f', 64));

-- ------------------------------------------------------------
-- The old entry point survives untouched
-- ------------------------------------------------------------

-- T1 — the exact signature every published client calls today.
SELECT has_function('public', 'log_gene_invocation', ARRAY['uuid', 'text'],
  'T1: log_gene_invocation(uuid, text) still exists');

-- T2 — and it still resolves. This is the assertion that fails loudly if
--   anyone "simplifies" the two entry points into one overload with a default
--   argument: the call becomes ambiguous and errors at resolution time.
SELECT lives_ok(
  $$ SELECT log_gene_invocation('d2222222-2222-4222-8222-222222222222', 'chan-caller-old') $$,
  'T2: a two-argument call still resolves to exactly one function');

-- T3 — an old client records a row, with no channel attributed to it.
SELECT is(
  (SELECT client_channel FROM gene_invocation_log
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'chan-caller-old'),
  NULL,
  'T3: a client that predates the column records NULL, not a guessed channel');

-- ------------------------------------------------------------
-- The new entry point
-- ------------------------------------------------------------

-- T4 — v2 exists with the channel argument.
SELECT has_function('public', 'log_gene_invocation_v2', ARRAY['uuid', 'text', 'text'],
  'T4: log_gene_invocation_v2(uuid, text, text) exists');

-- T5 — and stores what it was given.
SELECT log_gene_invocation_v2('d2222222-2222-4222-8222-222222222222', 'chan-caller-new', 'mcp:dsh');
SELECT is(
  (SELECT client_channel FROM gene_invocation_log
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'chan-caller-new'),
  'mcp:dsh',
  'T5: v2 records the channel it was given');

-- ------------------------------------------------------------
-- The guard spans both entry points (ADR-322 D1 under two front doors)
-- ------------------------------------------------------------

-- T6 — the real MCP shape: the spawned CLI reports first through the old entry
--   point, the MCP server reports a moment later through v2. One user action,
--   so one row. A guard that lived in only one function would let this through.
SELECT log_gene_invocation('d3333333-3333-4333-8333-333333333333', 'chan-caller-pair');
SELECT log_gene_invocation_v2('d3333333-3333-4333-8333-333333333333', 'chan-caller-pair', 'mcp:cursor');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'd3333333-3333-4333-8333-333333333333' AND caller_agent_id = 'chan-caller-pair'),
  1::bigint,
  'T6: old-then-new reports of one call collapse to a single row');

-- T6b — the winner keeps the channel it was written with. The second reporter
--   does not overwrite it: which report arrives first is a matter of process
--   timing, and a stored value that depends on that is not worth reading.
SELECT is(
  (SELECT client_channel FROM gene_invocation_log
    WHERE gene_id = 'd3333333-3333-4333-8333-333333333333' AND caller_agent_id = 'chan-caller-pair'),
  NULL,
  'T6b: the first report wins the row, channel included');

-- T7 — the mirror image: v2 first, then the old entry point.
SELECT log_gene_invocation_v2('d2222222-2222-4222-8222-222222222222', 'chan-caller-rev', 'cli');
SELECT log_gene_invocation('d2222222-2222-4222-8222-222222222222', 'chan-caller-rev');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'chan-caller-rev'),
  1::bigint,
  'T7: new-then-old reports of one call also collapse to a single row');

-- T8 — a genuine repeat outside the window is still recorded, through v2 too.
--   Back-dated rather than slept, same as the sibling suite.
UPDATE gene_invocation_log
   SET invoked_at = now() - INTERVAL '10 seconds'
 WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'chan-caller-rev';
SELECT log_gene_invocation_v2('d2222222-2222-4222-8222-222222222222', 'chan-caller-rev', 'cli');
SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'chan-caller-rev'),
  2::bigint,
  'T8: a repeat outside the window is real usage and is still recorded');

-- ------------------------------------------------------------
-- The shape constraint
-- ------------------------------------------------------------

-- T9 — a qualified channel is the shape the clients actually send.
SELECT lives_ok(
  $$ SELECT log_gene_invocation_v2('d3333333-3333-4333-8333-333333333333', 'chan-shape-ok', 'mcp:claude_code') $$,
  'T9: transport:host is accepted');

-- T9b — uppercase is rejected rather than stored. Two spellings of one host
--   would split it across every aggregate that groups by this column; this is
--   the identifier-boundary rule enforced at the door instead of hoped for.
SELECT throws_ok(
  $$ SELECT log_gene_invocation_v2('d3333333-3333-4333-8333-333333333333', 'chan-shape-upper', 'MCP:DSH') $$,
  '23514',
  NULL,
  'T9b: an uppercase channel is refused, not silently stored alongside its lowercase twin');

-- T9c — free text is refused too: this column is grouped by, not read as prose.
SELECT throws_ok(
  $$ SELECT log_gene_invocation_v2('d3333333-3333-4333-8333-333333333333', 'chan-shape-prose', 'Claude Code v1.2 (macOS)') $$,
  '23514',
  NULL,
  'T9c: free-form text is refused');

-- ------------------------------------------------------------
-- Permissions — the part Postgres gets wrong by default
-- ------------------------------------------------------------

-- T10 — the old entry point keeps its grant (20260527020805).
SELECT function_privs_are(
  'public', 'log_gene_invocation', ARRAY['uuid', 'text'],
  'authenticated', ARRAY['EXECUTE'],
  'T10: authenticated keeps EXECUTE on the original entry point');

-- T11 — the new entry point is granted the same way, and no wider.
SELECT function_privs_are(
  'public', 'log_gene_invocation_v2', ARRAY['uuid', 'text', 'text'],
  'authenticated', ARRAY['EXECUTE'],
  'T11: authenticated may call v2');

-- T12 — and anon may not. Postgres grants EXECUTE to PUBLIC on creation, so
--   this fails unless the migration revoked it explicitly. Without this the
--   public anon key could forge rows in the ledger behind the §33.4
--   anti-manipulation metrics.
SELECT function_privs_are(
  'public', 'log_gene_invocation_v2', ARRAY['uuid', 'text', 'text'],
  'anon', ARRAY[]::text[],
  'T12: anon cannot call v2 — the ledger is not writable with the public key');

-- T13 — the shared implementation is not a third front door.
SELECT function_privs_are(
  'public', 'log_gene_invocation_impl', ARRAY['uuid', 'text', 'text'],
  'anon', ARRAY[]::text[],
  'T13: anon cannot reach the shared implementation directly');

SELECT * FROM finish();

ROLLBACK;
