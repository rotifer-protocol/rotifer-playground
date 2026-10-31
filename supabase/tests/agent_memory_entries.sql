-- ============================================================
-- pgTAP tests for Agent Memory (migration 20261030220000, v0.9.4)
-- File: supabase/tests/agent_memory_entries.sql
-- ============================================================
--
-- A row-level policy that matches nothing returns zero rows without an
-- error, so every isolation test here counts rows (is(count, 0)) or reads a
-- value back as the owner, rather than only checking that a statement ran.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(100);

-- A and B are ordinary accounts; both register an agent called 'agent-1'.
-- C is closed later in the file.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('a7e11111-1111-4111-8111-111111111111', 'memory-a@example.com', '{"user_name": "memory_a"}'::jsonb),
  ('a7e22222-2222-4222-8222-222222222222', 'memory-b@example.com', '{"user_name": "memory_b"}'::jsonb),
  ('a7e33333-3333-4333-8333-333333333333', 'memory-c@example.com', '{"user_name": "memory_c"}'::jsonb),
  ('a7e44444-4444-4444-8444-444444444444', 'memory-d@example.com', '{"user_name": "memory_d"}'::jsonb);

-- ── Enums carry the spec's UPPERCASE values ───────────

SELECT is(enum_range(NULL::memory_category)::text, '{PREFERENCE,PATTERN,CONTEXT,CACHE}',
  'E1: memory_category has exactly the §38.1 values, uppercase');
SELECT is(enum_range(NULL::memory_access_scope)::text, '{CREATOR_GENE_ONLY,SAME_DOMAIN,ALL_GENES,DEPLOYER_CONFIGURED}',
  'E2: memory_access_scope has exactly the §38.1 values');
SELECT is(enum_range(NULL::memory_share_policy)::text, '{PRIVATE,ANONYMIZED_SHARE,KNOWLEDGE_GENE}',
  'E3: memory_share_policy has exactly the §38.1 values');
SELECT throws_ok($$ SELECT 'preference'::memory_category $$, '22P02', NULL,
  'E4: a lowercase category is a type error, not a silent mismatch');

-- ── Structure: no tie to genes ────────────────────────

SELECT is(
  (SELECT count(*)::int FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'genes'::regclass
      AND conrelid IN ('agent_memory_entries'::regclass, 'agent_memory_containers'::regclass)),
  0, 'S1: neither memory table has a foreign key to genes');

SELECT is(agent_memory_entry_id('agent-1', 'theme'),
  '6a9439755781cf822bc231bb18113eca746a71cdea14a6ba74b0be29fd352b52',
  'S2: entry_id is hex SHA-256 of agentId || 0x00 || key');

-- ── A writes ───────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a7e11111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT is(
  (agent_memory_write('agent-1', 'theme', convert_to('dark', 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme')
    -> 'entry' ->> 'entry_id'),
  '6a9439755781cf822bc231bb18113eca746a71cdea14a6ba74b0be29fd352b52',
  'W1: a write computes the entry id server-side');

SELECT results_eq(
  $$ SELECT read_scope::text, write_scope::text, share_policy::text, created_by, last_accessed_by
       FROM agent_memory_entries WHERE agent_id = 'agent-1' AND key = 'theme' $$,
  $$ VALUES ('SAME_DOMAIN', 'SAME_DOMAIN', 'PRIVATE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') $$,
  'W2: no accessPolicy means SAME_DOMAIN / SAME_DOMAIN / PRIVATE');

SELECT results_eq(
  $$ SELECT quota_bytes, total_size FROM agent_memory_container('agent-1') $$,
  $$ VALUES (10485760::bigint, 9::bigint) $$,
  'W3: the first write registers the agent with the 10 MB default; totalSize counts key + value bytes');

-- An update keeps the policy it was given unless a new one is sent. gene-a2
-- shares ui.theme, so writeScope SAME_DOMAIN lets it overwrite the value.
SELECT agent_memory_write('agent-1', 'theme', convert_to('dark', 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme',
                          'CREATOR_GENE_ONLY', 'SAME_DOMAIN', NULL);
SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme');
SELECT results_eq(
  $$ SELECT convert_from(value, 'UTF8') COLLATE "C", read_scope::text, created_by, last_accessed_by
       FROM agent_memory_entries WHERE agent_id = 'agent-1' AND key = 'theme' $$,
  $$ VALUES ('light' COLLATE "C", 'CREATOR_GENE_ONLY', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2') $$,
  'W4: an update replaces the value, keeps createdBy and the policy, records lastAccessedBy');

-- Only the creator gene may change an existing entry's policies. theme is
-- CREATOR_GENE_ONLY now, so open it to ALL_GENES first.
SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme',
                          'ALL_GENES', 'ALL_GENES', NULL);
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme',
                               'CREATOR_GENE_ONLY', NULL, NULL) AS r) x),
  'MEMORY_ACCESS_DENIED:%',
  'W8: another gene cannot change an existing entry''s accessPolicy');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme',
                               NULL, NULL, NULL,
                               '{"maxRetentionDays": 1, "autoDeleteOnTermination": true, "anonymizationSupported": false}'::jsonb, true) AS r) x),
  'MEMORY_ACCESS_DENIED:%',
  'W9: nor its retentionPolicy — a different policy is refused, not silently ignored');
SELECT lives_ok(
  $$ SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme',
                               'ALL_GENES', 'ALL_GENES', 'PRIVATE', NULL, true) $$,
  'W10: another gene may resend exactly the current policies (and retentionPolicy null) with its write');
SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme');

-- retentionPolicy null = reset to inherit; only the creator may.
SELECT lives_ok(
  $$ SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme',
                               NULL, NULL, NULL,
                               '{"maxRetentionDays": 30, "autoDeleteOnTermination": true, "anonymizationSupported": false}'::jsonb, true) $$,
  'W11: the creator sets a retentionPolicy');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme',
                               NULL, NULL, NULL, NULL, true) AS r) x),
  'MEMORY_ACCESS_DENIED:%',
  'W12: another gene cannot reset it to inherit (null) while it differs');
SELECT agent_memory_write('agent-1', 'theme', convert_to('light', 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme',
                          NULL, NULL, NULL, NULL, true);
SELECT is((SELECT retention_policy FROM agent_memory_entries WHERE agent_id = 'agent-1' AND key = 'theme'), NULL::jsonb,
  'W13: the creator can reset it to inherit');

-- Clients cannot choose the entry id or rewrite provenance.
SELECT throws_ok(
  $$ INSERT INTO agent_memory_entries (entry_id, agent_id, category, key, value, created_by)
     VALUES (repeat('0', 64), 'agent-1', 'CACHE', 'spoof', '\x00', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') $$,
  '42501', NULL,
  'W5: a client cannot set entry_id');
SELECT throws_ok(
  $$ UPDATE agent_memory_entries SET created_by = 'someone-else' WHERE key = 'theme' $$,
  '42501', NULL,
  'W6: a client cannot rewrite createdBy');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-1', 'shared', '\x00', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme',
                               NULL, NULL, 'ANONYMIZED_SHARE') AS r) x),
  'MEMORY_ACCESS_DENIED:%',
  'W7: sharePolicy other than PRIVATE is refused — no DataPolicy supports anonymization yet');

-- ── B: same agent id, separate memory ─────────────────

SET LOCAL request.jwt.claims = '{"sub":"a7e22222-2222-4222-8222-222222222222","role":"authenticated"}';

SELECT is((SELECT count(*)::int FROM agent_memory_entries), 0,
  'I1: B sees none of A''s entries');
SELECT is((SELECT count(*)::int FROM agent_memory_containers), 0,
  'I2: B sees none of A''s containers');
SELECT is((SELECT count(*)::int FROM agent_memory_container('agent-1')), 0,
  'I3: B has no container for agent-1 until B registers one');

SELECT lives_ok(
  $$ SELECT agent_memory_write('agent-1', 'theme', convert_to('blue', 'UTF8'), 'PREFERENCE', 'v2:b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', 'ui.theme') $$,
  'I4: B can register its own agent-1 — the same agent id does not collide');

SELECT results_eq(
  $$ SELECT owner_id::text, convert_from(value, 'UTF8') COLLATE "C" FROM agent_memory_entries $$,
  $$ VALUES ('a7e22222-2222-4222-8222-222222222222', 'blue' COLLATE "C") $$,
  'I5: B reads back only its own agent-1 entry');

UPDATE agent_memory_entries SET value = convert_to('hacked', 'UTF8')
 WHERE owner_id = 'a7e11111-1111-4111-8111-111111111111';
DELETE FROM agent_memory_entries WHERE owner_id = 'a7e11111-1111-4111-8111-111111111111';
DELETE FROM agent_memory_containers WHERE owner_id = 'a7e11111-1111-4111-8111-111111111111';

SELECT throws_ok(
  $$ INSERT INTO agent_memory_containers (owner_id, agent_id)
     VALUES ('a7e11111-1111-4111-8111-111111111111', 'agent-9') $$,
  '42501', NULL,
  'I6: B cannot register an agent under A''s account');
SELECT throws_ok(
  $$ INSERT INTO agent_memory_entries (owner_id, agent_id, category, key, value, created_by)
     VALUES ('a7e11111-1111-4111-8111-111111111111', 'agent-1', 'CACHE', 'planted', '\x00', 'v2:b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1') $$,
  '23503', NULL,
  'I7: B cannot plant an entry in A''s agent-1 — B''s view has no such agent (MEMORY_NOT_FOUND)');

SET LOCAL request.jwt.claims = '{"sub":"a7e11111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT results_eq(
  $$ SELECT convert_from(value, 'UTF8') COLLATE "C" FROM agent_memory_entries WHERE agent_id = 'agent-1' $$,
  $$ VALUES ('light' COLLATE "C") $$,
  'I8: B''s update and deletes touched nothing of A''s; nothing was planted');

RESET ROLE;
SELECT results_eq(
  $$ SELECT count(*)::int, count(DISTINCT owner_id)::int FROM agent_memory_entries
      WHERE entry_id = '6a9439755781cf822bc231bb18113eca746a71cdea14a6ba74b0be29fd352b52' $$,
  $$ VALUES (2, 2) $$,
  'I11: A and B hold the same entry_id for agent-1/theme as two separate rows — uniqueness is per (owner, entry_id)');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a7e11111-1111-4111-8111-111111111111","role":"authenticated"}';

RESET ROLE;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SELECT throws_ok($$ SELECT count(*) FROM agent_memory_entries $$, '42501', NULL,
  'I9: anon has no privilege on entries');
SELECT throws_ok($$ SELECT agent_memory_write('agent-1', 'k', '\x00', 'CACHE', 'g') $$, '42501', NULL,
  'I10: anon cannot call the write RPC');
RESET ROLE;

-- ── Quota and eviction order ──────────────────────────
-- Agent 'agent-q', quota 100 bytes. Every fixture entry is 20 bytes
-- (4-byte key + 16-byte value). Times are explicit so "oldest" is decided
-- by updated_at, not by the order rows come back in. pat1 was
-- created before pat2 but rewritten 30 minutes ago, so it counts as newer.

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a7e11111-1111-4111-8111-111111111111","role":"authenticated"}';

INSERT INTO agent_memory_containers (agent_id, quota_bytes) VALUES ('agent-q', 100);
INSERT INTO agent_memory_entries (agent_id, category, key, value, created_by, created_at, updated_at) VALUES
  ('agent-q', 'PREFERENCE', 'pref', convert_to(repeat('p', 16), 'UTF8'), 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', now() - interval '5 hours', now() - interval '5 hours'),
  ('agent-q', 'CONTEXT',    'ctx1', convert_to(repeat('x', 16), 'UTF8'), 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', now() - interval '4 hours', now() - interval '4 hours'),
  ('agent-q', 'PATTERN',    'pat1', convert_to(repeat('t', 16), 'UTF8'), 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', now() - interval '3 hours', now() - interval '30 minutes'),
  ('agent-q', 'PATTERN',    'pat2', convert_to(repeat('t', 16), 'UTF8'), 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', now() - interval '2 hours', now() - interval '2 hours'),
  ('agent-q', 'CACHE',      'cch1', convert_to(repeat('c', 16), 'UTF8'), 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', now() - interval '1 hour',  now() - interval '1 hour');

SELECT is((SELECT total_size FROM agent_memory_container('agent-q')), 100::bigint,
  'Q1: the agent is exactly at its 100-byte quota');

-- 20 more bytes: CACHE goes first, even though it is the newest entry.
SELECT is(
  (SELECT jsonb_path_query_array(
     agent_memory_write('agent-q', 'new1', convert_to(repeat('n', 16), 'UTF8'), 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') -> 'evicted',
     '$[*].key')),
  '["cch1"]'::jsonb,
  'Q2: over quota, CACHE is evicted first and reported back');

-- 20 more bytes: no CACHE left, so the PATTERN with the oldest updated_at:
-- pat2, although pat1 was created earlier.
SELECT is(
  (SELECT jsonb_path_query_array(
     agent_memory_write('agent-q', 'new2', convert_to(repeat('n', 16), 'UTF8'), 'PATTERN', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') -> 'evicted',
     '$[*].key')),
  '["pat2"]'::jsonb,
  'Q3: then PATTERN, oldest by updatedAt, only as many as needed');

-- 30 more bytes: the PATTERNs pat1 (30 min) and new2 (now) both go before
-- ctx1, a CONTEXT four hours old.
SELECT is(
  (SELECT jsonb_path_query_array(
     agent_memory_write('agent-q', 'new3', convert_to(repeat('n', 26), 'UTF8'), 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') -> 'evicted',
     '$[*].key')),
  '["pat1", "new2"]'::jsonb,
  'Q4: every PATTERN goes before any CONTEXT, however old the CONTEXT is');

-- 30 more bytes (20 over): no CACHE, no PATTERN: the oldest CONTEXT
-- (ctx1, 4 h old) goes, not new1 or new3 written just now.
SELECT is(
  (SELECT jsonb_path_query_array(
     agent_memory_write('agent-q', 'new4', convert_to(repeat('n', 26), 'UTF8'), 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') -> 'evicted',
     '$[*].key')),
  '["ctx1"]'::jsonb,
  'Q5: then CONTEXT, oldest first');

SELECT results_eq(
  $$ SELECT key FROM agent_memory_entries WHERE agent_id = 'agent-q' ORDER BY key $$,
  $$ VALUES ('new1'), ('new3'), ('new4'), ('pref') $$,
  'Q6: PREFERENCE survived every eviction');

-- Overwriting an entry with a value of the same size evicts nothing, and
-- the entry is never its own eviction candidate.
SELECT is(
  (agent_memory_write('agent-q', 'new4', convert_to(repeat('m', 26), 'UTF8'), 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') -> 'evicted'),
  '[]'::jsonb,
  'Q7: an update that does not grow the entry evicts nothing');

-- 90 bytes of PREFERENCE: even evicting new1, new3 and new4 (80 bytes)
-- cannot make room next to the 20-byte pref.
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-q', 'big1', convert_to(repeat('b', 86), 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') AS r) x),
  'MEMORY_QUOTA_EXCEEDED:%',
  'Q8: when eviction cannot make room the write is refused (SQLSTATE 53400)');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-q', 'big1', convert_to(repeat('b', 86), 'UTF8'), 'PREFERENCE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') AS r) x),
  'MEMORY_QUOTA_EXCEEDED:%',
  'Q9: ...with the contract error code MEMORY_QUOTA_EXCEEDED');
SELECT results_eq(
  $$ SELECT key FROM agent_memory_entries WHERE agent_id = 'agent-q' ORDER BY key $$,
  $$ VALUES ('new1'), ('new3'), ('new4'), ('pref') $$,
  'Q10: a refused write evicts nothing and writes nothing');

-- The same rules hold for a direct insert, not only the RPC.
SELECT throws_ok(
  $$ INSERT INTO agent_memory_entries (agent_id, category, key, value, created_by)
     VALUES ('agent-q', 'PREFERENCE', 'big2', convert_to(repeat('b', 86), 'UTF8'), 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') $$,
  '53400', NULL,
  'Q11: a direct insert past the quota is refused too');

SELECT throws_ok(
  $$ UPDATE agent_memory_containers SET quota_bytes = 104857601 WHERE agent_id = 'agent-q' $$,
  '23514', NULL,
  'Q12: the Cloud caps a quota at 100 MiB per agent');
SELECT throws_ok(
  $$ INSERT INTO agent_memory_containers (agent_id, quota_bytes) VALUES ('agent-zero', 0) $$,
  '23514', NULL,
  'Q13: a zero quota is refused');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-q', '', '\x00', 'CACHE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') AS r) x),
  'MEMORY_INVALID_INPUT:%',
  'Q14: an empty key is refused');

-- ── queryMemory: scope before LIMIT ─────
-- Caller gene-a1 in ui.theme. The newest entry (a%2) is another gene's
-- CREATOR_GENE_ONLY, b4 is SAME_DOMAIN in another domain, d6 is
-- DEPLOYER_CONFIGURED: none of the three is readable.

INSERT INTO agent_memory_containers (agent_id) VALUES ('agent-qry');
INSERT INTO agent_memory_entries (agent_id, category, key, value, created_by, created_by_domain, read_scope, created_at, updated_at) VALUES
  ('agent-qry', 'CONTEXT', 'a%1', '\x01', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', 'SAME_DOMAIN',         now() - interval '2 hours', now() - interval '60 minutes'),
  ('agent-qry', 'CONTEXT', 'a%2', '\x01', 'v2:e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',  'other.d',  'CREATOR_GENE_ONLY',   now() - interval '2 hours', now() - interval '10 minutes'),
  ('agent-qry', 'CACHE',   'ab3', '\x01', 'v2:e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',  'other.d',  'ALL_GENES',           now() - interval '2 hours', now() - interval '30 minutes'),
  ('agent-qry', 'PATTERN', 'b4',  '\x01', 'v2:e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',  'other.d',  'SAME_DOMAIN',         now() - interval '2 hours', now() - interval '20 minutes'),
  ('agent-qry', 'PATTERN', 'd6',  '\x01', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', 'DEPLOYER_CONFIGURED', now() - interval '2 hours', now() - interval '5 minutes');

SELECT is(
  jsonb_path_query_array(agent_memory_query('agent-qry', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', p_limit => 1) -> 'entries', '$[*].key'),
  '["ab3"]'::jsonb,
  'QY1: limit 1 returns the newest entry the caller may read, not the newest entry');
SELECT is(
  jsonb_path_query_array(agent_memory_query('agent-qry', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') -> 'entries', '$[*].key'),
  '["ab3", "a%1"]'::jsonb,
  'QY2: every readable entry, newest first; unreadable ones are absent');
SELECT is(
  jsonb_path_query_array(agent_memory_query('agent-qry', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', p_key_prefix => 'a%') -> 'entries', '$[*].key'),
  '["a%1"]'::jsonb,
  'QY3: keyPrefix is a plain prefix — ''%'' is not a wildcard');

SET LOCAL request.jwt.claims = '{"sub":"a7e22222-2222-4222-8222-222222222222","role":"authenticated"}';
SELECT is(jsonb_array_length(agent_memory_query('agent-qry', 'v2:e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0', 'other.d') -> 'entries'), 0,
  'QY4: another account''s query sees none of it, even naming the creator gene');
SET LOCAL request.jwt.claims = '{"sub":"a7e11111-1111-4111-8111-111111111111","role":"authenticated"}';

-- writeScope is checked inside agent_memory_write, under the row lock.
-- b4 is SAME_DOMAIN in other.d.
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-qry', 'b4', '\x02', 'PATTERN', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'MEMORY_ACCESS_DENIED: write denied%',
  'X1: a gene outside the entry''s writeScope cannot overwrite it, even through the RPC');
SELECT lives_ok(
  $$ SELECT agent_memory_write('agent-qry', 'b4', '\x02', 'PATTERN', 'v2:e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 'other.d') $$,
  'X2: a gene inside it can');

-- deleteMemory checks writeScope in the same transaction as the delete.
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_delete('agent-qry', 'b4', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'MEMORY_ACCESS_DENIED: delete denied%',
  'DX1: a gene outside the entry''s writeScope cannot delete it through the RPC');
-- Two statements: a subquery in the same statement as the delete would
-- read the snapshot from before it.
SELECT is(agent_memory_delete('agent-qry', 'b4', 'v2:e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 'other.d') ->> 'key', 'b4',
  'DX2: a gene inside it deletes it');
SELECT is((SELECT count(*)::int FROM agent_memory_entries WHERE agent_id = 'agent-qry' AND key = 'b4'), 0,
  'DX2b: ...and the row is gone');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_delete('agent-qry', 'b4', 'v2:e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 'other.d') AS r) x),
  'MEMORY_NOT_FOUND:%',
  'DX3: deleting a missing key is MEMORY_NOT_FOUND');

-- ── retentionPolicy is exactly §30.2 RetentionPolicy ─────

SELECT lives_ok(
  $$ SELECT agent_memory_write('agent-ret', 'r', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL,
       '{"maxRetentionDays": null, "autoDeleteOnTermination": true, "anonymizationSupported": false}'::jsonb, true) $$,
  'RV1: the three §30.2 fields (maxRetentionDays null = unlimited) are accepted');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-ret', 's', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL,
       '{"maxRetentionDays": 30, "autoDeleteOnTermination": true}'::jsonb, true) AS r) x),
  'MEMORY_INVALID_INPUT:%',
  'RV2: a missing field is refused');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-ret', 's', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL,
       '{"maxRetentionDays": 30, "autoDeleteOnTermination": true, "anonymizationSupported": false, "note": "x"}'::jsonb, true) AS r) x),
  'MEMORY_INVALID_INPUT:%',
  'RV3: an extra field is refused — retentionPolicy cannot carry data past the quota');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-ret', 's', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL,
       '{"maxRetentionDays": 0, "autoDeleteOnTermination": true, "anonymizationSupported": false}'::jsonb, true) AS r) x),
  'MEMORY_INVALID_INPUT:%',
  'RV4: maxRetentionDays must be a positive integer (0 refused)');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-ret', 's', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL,
       '{"maxRetentionDays": "30", "autoDeleteOnTermination": "yes", "anonymizationSupported": false}'::jsonb, true) AS r) x),
  'MEMORY_INVALID_INPUT:%',
  'RV5: wrong types are refused');
SELECT is((SELECT total_size FROM agent_memory_container('agent-ret')), 2::bigint,
  'RV6: the quota counts key + value only');

-- ── Retention is enforced, lazily ───────────
-- Written now (T) with maxRetentionDays 1, an entry is still there at
-- T + 1 day - 1 s and gone at T + 1 day + 1 s. The clock is injected with
-- rotifer.memory_now, which only a privileged role can do (CK1/CK2), so the
-- clock-dependent checks run as postgres with A's claims still set: the
-- RPCs still act for auth.uid() = A. "keep" has no policy (inherits; the
-- Cloud has no DataPolicy, so never expires); "unl" has maxRetentionDays null.

SELECT agent_memory_write('ex-get', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-get', 'keep', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme');
SELECT agent_memory_write('ex-q', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-q', 'keep', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme');
SELECT agent_memory_write('ex-q', 'unl', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": null, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-w', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-d', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-d2', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-d2', 'live', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme');
SELECT agent_memory_write('ex-role', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-dn', 'old', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT agent_memory_write('ex-dn', 'priv', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', 'CREATOR_GENE_ONLY', NULL, NULL);

-- An authenticated client cannot move the clock.
SELECT set_config('rotifer.memory_now', (now() + interval '2 days')::text, true);
SELECT is(jsonb_typeof(agent_memory_read('ex-role', 'old', NULL, 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') -> 'entry'), 'object',
  'CK1: as authenticated, an injected clock is ignored — the 1-day entry is still there');
RESET ROLE;
SELECT is(jsonb_typeof(agent_memory_read('ex-role', 'old', NULL, 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') -> 'entry'), 'null',
  'CK2: the same setting from a privileged role is honoured, so CK1 was not passing by accident');

SELECT set_config('rotifer.memory_now', (now() + interval '1 day' - interval '1 second')::text, true);
SELECT ok(
  (SELECT jsonb_typeof(r -> 'entry') = 'object' AND r -> 'expired' = '[]'::jsonb
     FROM (SELECT agent_memory_read('ex-get', 'old', NULL, 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'RT1: 1 second before it expires, the entry is still returned, and expired is []');
SELECT is(jsonb_array_length(agent_memory_query('ex-q', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') -> 'entries'), 3,
  'RT2: ...and still listed');

SELECT set_config('rotifer.memory_now', (now() + interval '1 day' + interval '1 second')::text, true);
SELECT ok(
  (SELECT jsonb_typeof(r -> 'entry') = 'null' AND r -> 'expired' = jsonb_build_array(jsonb_build_object('entryId', agent_memory_entry_id('ex-get', 'old')))
     FROM (SELECT agent_memory_read('ex-get', 'old', NULL, 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'RT3: 1 second after, a read returns no entry and reports the purged entry id (no key)');
SELECT is((SELECT count(*)::int FROM agent_memory_entries WHERE agent_id = 'ex-get' AND key = 'old'), 0,
  'RT4: ...because the read purged it, not merely hid it');
SELECT ok(
  (SELECT (SELECT jsonb_agg(k ORDER BY k COLLATE "C") FROM jsonb_array_elements_text(jsonb_path_query_array(r -> 'entries', '$[*].key')) k) = '["keep", "unl"]'::jsonb AND r -> 'expired' = jsonb_build_array(jsonb_build_object('entryId', agent_memory_entry_id('ex-q', 'old')))
     FROM (SELECT agent_memory_query('ex-q', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'RT5: a query omits it and reports its id; no policy and maxRetentionDays null never expire');
SELECT is((SELECT total_size FROM agent_memory_container('ex-q')), 9::bigint,
  'RT6: it no longer counts toward quota (keep 4+1, unl 3+1 bytes)');
SELECT results_eq(
  $$ SELECT (r -> 'entry' ->> 'created_by') COLLATE "C", r -> 'expired'
       FROM (SELECT agent_memory_write('ex-w', 'old', '\x02', 'CONTEXT', 'v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', 'ui.theme') AS r) w $$,
  $$ VALUES ('v2:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2' COLLATE "C", jsonb_build_array(jsonb_build_object('entryId', agent_memory_entry_id('ex-w', 'old')))) $$,
  'RT7: a write to an expired key is a fresh create, and reports the purged entry id');
SELECT alike(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_delete('ex-d', 'old', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'MEMORY_NOT_FOUND:%',
  'RT8: deleting an expired entry finds nothing');
SELECT ok(
  (SELECT r ->> 'key' = 'live' AND r -> 'expired' = jsonb_build_array(jsonb_build_object('entryId', agent_memory_entry_id('ex-d2', 'old')))
     FROM (SELECT agent_memory_delete('ex-d2', 'live', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'RT9: a delete reports the expired entries it purged on the way');

SELECT ok(
  (SELECT r -> 'error' ->> 'code' = 'MEMORY_ACCESS_DENIED'
      AND r -> 'expired' = jsonb_build_array(jsonb_build_object('entryId', agent_memory_entry_id('ex-dn', 'old')))
     FROM (SELECT agent_memory_read('ex-dn', 'priv', NULL, 'v2:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', 'other.d') AS r) x),
  'RF1: a refused read still purges the expired entries and reports them in the error');
SELECT is((SELECT count(*)::int FROM agent_memory_entries WHERE agent_id = 'ex-dn' AND key = 'old'), 0,
  'RF2: ...and the purge was committed with the refusal');

SELECT set_config('rotifer.memory_now', (now() + interval '100 years')::text, true);
SELECT ok(
  (SELECT (SELECT jsonb_agg(k ORDER BY k COLLATE "C") FROM jsonb_array_elements_text(jsonb_path_query_array(r -> 'entries', '$[*].key')) k) = '["keep", "unl"]'::jsonb AND r -> 'expired' = '[]'::jsonb
     FROM (SELECT agent_memory_query('ex-q', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') AS r) x),
  'RT10: a century later the two without a retention limit are still there, nothing expired');
SELECT set_config('rotifer.memory_now', '', true);
SET LOCAL ROLE authenticated;

-- ── Expiry arithmetic ──────────────────────
-- A day is 86400 seconds whatever the session time zone: 2026-11-01 is the
-- day Los Angeles leaves DST, when a calendar day is 25 hours.
SET LOCAL timezone = 'America/Los_Angeles';
SELECT ok(agent_memory_expired('{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, '2026-11-01 00:30:00-07', '2026-11-01 00:30:00-07'::timestamptz + interval '86400 seconds'),
  'RX1: exactly 86400 s after updatedAt a 1-day entry has expired, across a DST change');
SELECT ok(NOT agent_memory_expired('{"maxRetentionDays": 1, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, '2026-11-01 00:30:00-07', '2026-11-01 00:30:00-07'::timestamptz + interval '86399 seconds'),
  'RX2: ...and 1 s earlier it has not');
SET LOCAL timezone TO DEFAULT;

-- The largest valid maxRetentionDays must not overflow anything.
SELECT agent_memory_write('ex-max', 'big', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme', NULL, NULL, NULL, '{"maxRetentionDays": 2147483647, "autoDeleteOnTermination": false, "anonymizationSupported": false}'::jsonb, true);
SELECT lives_ok(
  $$ SELECT agent_memory_query('ex-max', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') $$,
  'RX3: a query on an agent holding maxRetentionDays 2147483647 works');
SELECT is(jsonb_typeof(agent_memory_read('ex-max', 'big', NULL, 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') -> 'entry'), 'object',
  'RX4: ...a read returns the entry');
SELECT is((SELECT total_size FROM agent_memory_container('ex-max')), 4::bigint,
  'RX5: ...usage counts it');
SELECT lives_ok(
  $$ SELECT agent_memory_delete('ex-max', 'big', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme') $$,
  'RX6: ...and it can be deleted');

-- ── Calling gene must be a v2 id; DEPLOYER_CONFIGURED cannot be set ──

SELECT throws_like(
  $$ SELECT agent_memory_write('agent-v3', 'k', '\x01', 'CONTEXT', 'gene-plain', 'ui.theme') $$,
  'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id%',
  'V1: a caller id that is not v2:<64 hex> is refused');
SELECT is(
  (SELECT count(*)::int FROM agent_memory_containers WHERE agent_id = 'agent-v3')
  + (SELECT count(*)::int FROM agent_memory_entries WHERE agent_id = 'agent-v3'),
  0, 'V2: ...and nothing was recorded, not even the agent''s container');
SELECT throws_like(
  $$ SELECT agent_memory_write('agent-v3', 'k', '\x01', 'CONTEXT', 'V2:A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1', 'ui.theme') $$,
  'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id%',
  'V3: uppercase hex is not a v2 id either');
SELECT throws_like(
  $$ SELECT agent_memory_delete('agent-qry', 'a%1', 'gene-plain', 'ui.theme') $$,
  'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id%',
  'V4: delete refuses it too');
SELECT throws_like(
  $$ SELECT * FROM agent_memory_query('agent-qry', 'gene-plain', 'ui.theme') $$,
  'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id%',
  'V5: and query');
SELECT throws_like(
  $$ SELECT agent_memory_write('agent-v3', 'k', '\x01', 'CONTEXT', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'ui.theme',
                               'DEPLOYER_CONFIGURED', NULL, NULL) $$,
  'MEMORY_ACCESS_DENIED: DEPLOYER_CONFIGURED cannot be set%',
  'V6: readScope or writeScope DEPLOYER_CONFIGURED cannot be set');

-- ── Value size limit ───────────────────

SELECT lives_ok(
  $$ SELECT agent_memory_write('agent-big', 'v', decode(repeat('ab', 1048576), 'hex'), 'CACHE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') $$,
  'L1: a value of exactly 1 MiB (1048576 bytes) is accepted');
SELECT is(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-big', 'w', decode(repeat('ab', 1048577), 'hex'), 'CACHE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1') AS r) x),
  'MEMORY_INVALID_INPUT: value is 1048577 bytes; the limit is 1048576 (1 MiB)' COLLATE "C",
  'L2: one byte more is refused with MEMORY_INVALID_INPUT, not truncated');

-- ── Reading is not updating ────────────────────────────────

UPDATE agent_memory_entries SET last_accessed_by = 'v2:adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad' WHERE agent_id = 'agent-q' AND key = 'pref';
SELECT results_eq(
  $$ SELECT last_accessed_by, updated_at = created_at FROM agent_memory_entries
      WHERE agent_id = 'agent-q' AND key = 'pref' $$,
  $$ VALUES ('v2:adadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad', true) $$,
  'R1: recording lastAccessedBy leaves updatedAt alone');

RESET ROLE;
RESET request.jwt.claims;

SELECT throws_ok(
  $$ UPDATE agent_memory_entries SET created_at = now() - interval '9 days' WHERE key = 'pref' $$,
  '22023', NULL,
  'R2: no role can rewrite an entry''s creation time (trigger, not only grants)');

-- ── Genome changes never touch memory ─────────────────

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('a7e00000-0000-4000-8000-00000000000a', 'a7e11111-1111-4111-8111-111111111111', 'mem-gene-draft', 'test.memory', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('a', 64)),
  ('a7e00000-0000-4000-8000-00000000000b', 'a7e11111-1111-4111-8111-111111111111', 'mem-gene-kept',  'test.memory', '0.1.0', 'Wrapped', '{}'::jsonb, false, repeat('b', 64));

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a7e11111-1111-4111-8111-111111111111","role":"authenticated"}';

SELECT agent_memory_write('agent-1', 'by-draft', convert_to('v', 'UTF8'), 'CONTEXT', 'v2:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
SELECT agent_memory_write('agent-1', 'by-kept',  convert_to('v', 'UTF8'), 'PATTERN', 'v2:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');

DELETE FROM genes WHERE id = 'a7e00000-0000-4000-8000-00000000000a';
UPDATE genes SET version = '0.2.0' WHERE id = 'a7e00000-0000-4000-8000-00000000000b';

SELECT is((SELECT count(*)::int FROM genes WHERE id = 'a7e00000-0000-4000-8000-00000000000a'), 0,
  'G1: the creator gene really was deleted');
SELECT results_eq(
  $$ SELECT key, created_by FROM agent_memory_entries
      WHERE agent_id = 'agent-1' AND key IN ('by-draft', 'by-kept') ORDER BY key $$,
  $$ VALUES ('by-draft', 'v2:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a'),
            ('by-kept',  'v2:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b') $$,
  'G2: deleting or updating a gene leaves its memory and createdBy in place');

-- Deleting the agent's container deletes its entries.
SELECT agent_memory_write('agent-del', 'k1', '\x01', 'CACHE', 'v2:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1');
DELETE FROM agent_memory_containers WHERE agent_id = 'agent-del';
SELECT is((SELECT count(*)::int FROM agent_memory_entries WHERE agent_id = 'agent-del'), 0,
  'G3: the owner deleting the container deletes its entries');

-- ── Per-account quota ceiling: 200 MiB ─────

SET LOCAL request.jwt.claims = '{"sub":"a7e44444-4444-4444-8444-444444444444","role":"authenticated"}';
SELECT lives_ok(
  $$ INSERT INTO agent_memory_containers (agent_id, quota_bytes) VALUES ('d1', 104857600), ('d2', 104857600) $$,
  'PA1: two 100 MiB agents fill one account''s 200 MiB exactly');
SELECT throws_ok(
  $$ INSERT INTO agent_memory_containers (agent_id, quota_bytes) VALUES ('d3', 1) $$,
  '53400', NULL,
  'PA2: one more byte of quota on a new agent is refused (MEMORY_QUOTA_EXCEEDED)');
SELECT throws_ok(
  $$ UPDATE agent_memory_containers SET quota_bytes = quota_bytes + 1 WHERE agent_id = 'd1' $$,
  '53400', NULL,
  'PA3: so is raising an existing agent''s quota past the ceiling');
SELECT lives_ok(
  $$ SELECT agent_memory_write('d1', 'k', '\x01', 'CACHE', 'v2:d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1') $$,
  'PA4: writing to an existing agent at the ceiling still works — re-registering is not a new claim');

-- ── Closed accounts (20261022100000 / 20261022110000) ──────

SET LOCAL request.jwt.claims = '{"sub":"a7e33333-3333-4333-8333-333333333333","role":"authenticated"}';
SELECT agent_memory_write('agent-c', 'likes', convert_to('tea', 'UTF8'), 'PREFERENCE', 'v2:c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1');
RESET ROLE;

SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT * FROM close_account('a7e33333-3333-4333-8333-333333333333', 'user_request');
RESET request.jwt.claims;

SELECT is(
  (SELECT count(*)::int FROM agent_memory_entries WHERE owner_id = 'a7e33333-3333-4333-8333-333333333333')
  + (SELECT count(*)::int FROM agent_memory_containers WHERE owner_id = 'a7e33333-3333-4333-8333-333333333333'),
  0, 'C1: closing an account deletes its agents'' memory');
SELECT is(
  (SELECT count(*)::int FROM agent_memory_entries WHERE owner_id = 'a7e11111-1111-4111-8111-111111111111' AND agent_id = 'agent-1'),
  3, 'C2: other accounts'' memory is untouched');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a7e33333-3333-4333-8333-333333333333","role":"authenticated"}';
SELECT is(
  (SELECT ((r -> 'error' ->> 'code') || ': ' || (r -> 'error' ->> 'message')) COLLATE "C" FROM (SELECT agent_memory_write('agent-c', 'likes', convert_to('coffee', 'UTF8'), 'PREFERENCE', 'v2:c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1') AS r) x),
  'MEMORY_ACCESS_DENIED: this account is closed and can no longer write' COLLATE "C",
  'C3: a closed account''s leftover token cannot write memory');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
