-- ============================================================
-- pgTAP tests for node attestation (PoR), v0.9.5 A1 Cloud side
-- Migration: supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql
-- File: supabase/tests/node_attestation.sql
-- ============================================================
--
-- The migration is deferred (not in supabase/migrations/), so a plain
-- `supabase test db` has no nodes table and this file reports one skip.
-- To run it, apply the deferred file to the local database first:
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql
--   supabase test db
--
-- A row-level policy that matches nothing returns zero rows without an
-- error, so isolation is asserted by counting rows (is(count, 0)), not by
-- checking that a statement ran.
--
-- Everything happens in one transaction, so now() is one instant: :now below.
-- Certificates "issued earlier" are inserted directly as postgres (inserts
-- are allowed; the log is append-only, not insert-only).

SELECT to_regclass('public.nodes') IS NOT NULL AS has_nodes \gset

\if :has_nodes

BEGIN;

SELECT plan(74);

-- The edge function's role. postgres may switch to it only once granted.
-- pgTAP's own functions live in the extensions schema, which por_issuer
-- cannot see (it needs nothing there: the PoR functions run as their owner),
-- so the assertions made while switched to it need that schema too. Both
-- grants are rolled back with everything else.
GRANT por_issuer TO postgres;
GRANT USAGE ON SCHEMA extensions TO por_issuer;

SELECT floor(extract(epoch FROM now()))::bigint AS now \gset
SELECT :now + 604800 AS exp \gset

-- A, B: ordinary accounts. C is closed later, D is banned.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('d0e11111-1111-4111-8111-111111111111', 'por-a@example.com', '{"user_name": "por_a"}'::jsonb),
  ('d0e22222-2222-4222-8222-222222222222', 'por-b@example.com', '{"user_name": "por_b"}'::jsonb),
  ('d0e33333-3333-4333-8333-333333333333', 'por-c@example.com', '{"user_name": "por_c"}'::jsonb),
  ('d0e44444-4444-4444-8444-444444444444', 'por-d@example.com', '{"user_name": "por_d"}'::jsonb);

\set A '''d0e11111-1111-4111-8111-111111111111'''
\set B '''d0e22222-2222-4222-8222-222222222222'''
\set C '''d0e33333-3333-4333-8333-333333333333'''
\set D '''d0e44444-4444-4444-8444-444444444444'''
\set AUD '''http://127.0.0.1:54321/functions/v1/node-attestation'''
\set SUBA '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
\set SUBB '''bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'''
\set P1 '''12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB'''
\set P2 '''12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5'''
\set P3 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3'''
\set P4 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4'''
\set P5 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5'''
\set P6 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6'''
\set P7 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7'''
\set P8 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8'''
\set P9 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9'''
\set P10 '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB'''
\set PC '''12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC'''

-- ── Structure, privileges, RLS ─────────────────────────────

SELECT is(
  (SELECT count(*)::int FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relrowsecurity
      AND relname IN ('nodes', 'node_attestation_issuances', 'node_attestation_challenges', 'node_attestation_revocations')),
  4, 'S1: RLS is on for all four tables');

SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'nodes'),
  1, 'S2: nodes has exactly one policy (owner read)');
SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('node_attestation_issuances', 'node_attestation_challenges', 'node_attestation_revocations')),
  0, 'S3: the issuance log, challenges and revocations have no policy at all');

SELECT is(
  (SELECT count(*)::int
     FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'por_issuer']) r,
          unnest(ARRAY['nodes', 'node_attestation_issuances', 'node_attestation_challenges', 'node_attestation_revocations']) t,
          unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
    WHERE has_table_privilege(r, 'public.' || t, p)),
  0, 'S4: no client role, not service_role and not por_issuer may write any of the four tables directly');

SELECT is(
  (SELECT array_agg(t ORDER BY t)
     FROM unnest(ARRAY['nodes', 'node_attestation_issuances', 'node_attestation_challenges', 'node_attestation_revocations']) t
    WHERE has_table_privilege('authenticated', 'public.' || t, 'SELECT')),
  ARRAY['nodes'], 'S5: authenticated may read nodes (under RLS) and nothing else');

SELECT is(
  (SELECT count(*)::int
     FROM unnest(ARRAY['anon', 'authenticated']) r,
          unnest(ARRAY['node_attestation_challenge(uuid,text)',
                       'node_attestation_issue(uuid,text,bytea,bigint,text,text,bigint,bigint,text)',
                       'node_attestation_revoke(text,bigint,text)',
                       'node_attestation_revocations_for_jwks()',
                       'node_attestation_account_open(uuid)']) f
    WHERE has_function_privilege(r, 'public.' || f, 'EXECUTE')),
  0, 'S6: anon and authenticated cannot execute any PoR function');

SELECT ok(
  (SELECT bool_and(has_function_privilege('por_issuer', 'public.' || f, 'EXECUTE'))
     FROM unnest(ARRAY['node_attestation_challenge(uuid,text)',
                       'node_attestation_issue(uuid,text,bytea,bigint,text,text,bigint,bigint,text)',
                       'node_attestation_revoke(text,bigint,text)',
                       'node_attestation_revocations_for_jwks()']) f)
  AND (SELECT count(*) = 0
     FROM unnest(ARRAY['service_role', 'authenticated']) r,
          unnest(ARRAY['node_attestation_challenge(uuid,text)',
                       'node_attestation_issue(uuid,text,bytea,bigint,text,text,bigint,bigint,text)',
                       'node_attestation_revoke(text,bigint,text)',
                       'node_attestation_revocations_for_jwks()']) f
    WHERE has_function_privilege(r, 'public.' || f, 'EXECUTE')),
  'S7: por_issuer can execute the four PoR functions; service_role and authenticated cannot execute any of them');

SELECT is(
  (SELECT count(*)::int
     FROM unnest(ARRAY['node_attestation_account_open(uuid)', 'node_attestation_issuances_append_only()']) f
    WHERE has_function_privilege('service_role', 'public.' || f, 'EXECUTE')),
  0, 'S9: service_role cannot execute the two internal helpers either');

SELECT is(
  (SELECT count(*)::int FROM unnest(ARRAY['node_attestation_account_open(uuid)',
                                          'node_attestation_issuances_append_only()']) f
    WHERE has_function_privilege('por_issuer', 'public.' || f, 'EXECUTE'))
  + (SELECT count(*)::int FROM unnest(ARRAY['nodes', 'node_attestation_issuances',
                                            'node_attestation_challenges', 'node_attestation_revocations']) t
    WHERE has_table_privilege('por_issuer', 'public.' || t, 'SELECT')),
  0, 'S10: por_issuer cannot execute the internal helpers nor read any of the four tables');

SELECT is(
  (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication OR rolinherit
     FROM pg_roles WHERE rolname = 'por_issuer'),
  false, 'S11: por_issuer is not superuser, cannot create roles or databases, does not bypass RLS, does not inherit');

SELECT is(
  (SELECT count(*)::int FROM pg_constraint
    WHERE contype = 'f' AND conrelid = 'public.node_attestation_issuances'::regclass),
  0, 'S8: the issuance log has no foreign key, so it outlives an account row');

-- ── Challenges ─────────────────────────────────────────────

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:A, :AUD) AS ch1 \gset
RESET ROLE;

SELECT is(octet_length(decode((:'ch1'::jsonb) ->> 'nonce', 'hex')), 32, 'C1: the nonce is 32 bytes');
SELECT is(((:'ch1'::jsonb) ->> 'challenge_exp')::bigint, (:now + 300)::bigint, 'C2: the challenge is valid for 300 s');
SELECT ((:'ch1'::jsonb) ->> 'nonce') AS n1, ((:'ch1'::jsonb) ->> 'challenge_exp') AS e1 \gset

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:A, :AUD) AS ch2 \gset
RESET ROLE;
SELECT isnt((:'ch2'::jsonb) ->> 'nonce', :'n1', 'C3: two challenges get different nonces');

-- ── Issue, single-use nonce ────────────────────────────────

SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_issue(:A, :AUD, decode(:'n1', 'hex'), :e1, :P1, :SUBA, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'I1: A redeems a fresh challenge for P1');
SELECT is(node_attestation_issue(:A, :AUD, decode(:'n1', 'hex'), :e1, :P1, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_CHALLENGE_INVALID"}'::jsonb, 'N1 (P0): the same nonce redeemed again is refused');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM node_attestation_issuances WHERE peer_id = :P1), 1,
  'N2: the refused replay recorded nothing');
SELECT results_eq(
  $$ SELECT user_id, sub, cert_iat, cert_exp, cert_kid FROM nodes WHERE peer_id = '12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB' $$,
  format($$ VALUES (%L::uuid, %L, %s::bigint, %s::bigint, 'k1') $$, :A, :SUBA, :now, :exp),
  'I2: nodes holds peer_id -> user_id, pseudonym and the current certificate');

-- Another account, another aud, another deadline: refused, and A's nonce stays usable.
SELECT ((:'ch2'::jsonb) ->> 'nonce') AS n2, ((:'ch2'::jsonb) ->> 'challenge_exp') AS e2 \gset
SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_issue(:B, :AUD, decode(:'n2', 'hex'), :e2, :P2, :SUBB, :now, :exp, 'k1'),
  '{"error": "POR_CHALLENGE_INVALID"}'::jsonb, 'N3: B cannot redeem a challenge issued to A');
SELECT is(node_attestation_issue(:A, 'https://shadow.example/functions/v1/node-attestation', decode(:'n2', 'hex'), :e2, :P2, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_CHALLENGE_INVALID"}'::jsonb, 'N4: a challenge from one aud is refused at another');
SELECT is(node_attestation_issue(:A, :AUD, decode(:'n2', 'hex'), :e2::bigint + 1, :P2, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_CHALLENGE_INVALID"}'::jsonb, 'N5: a changed deadline does not match the challenge');
SELECT is(node_attestation_issue(:A, :AUD, decode(:'n2', 'hex'), :e2, :P2, :SUBA, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'N6: the refusals above did not consume A''s nonce; A redeems it for P2');
SELECT is(node_attestation_issue(:A, :AUD, decode(repeat('ab', 32), 'hex'), :now + 300, :P2, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_CHALLENGE_INVALID"}'::jsonb, 'N7: an unknown nonce is refused');
RESET ROLE;

-- An expired challenge: refused and consumed.
INSERT INTO node_attestation_challenges (nonce, user_id, aud, challenge_exp)
VALUES (decode(repeat('01', 32), 'hex'), :A, :AUD, :now - 1);
SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_issue(:A, :AUD, decode(repeat('01', 32), 'hex'), :now - 1, :P3, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_CHALLENGE_EXPIRED"}'::jsonb, 'N8: an expired challenge is refused');
RESET ROLE;
SELECT isnt((SELECT consumed_at FROM node_attestation_challenges WHERE nonce = decode(repeat('01', 32), 'hex')), NULL,
  'N9: ... and consumed, so it cannot be tried again');

-- Bad times are a caller bug, raised.
SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:A, :AUD) AS ch \gset
SELECT throws_ok(
  format($$ SELECT node_attestation_issue(%L, %L, decode(%L, 'hex'), %s, %L, %L, %s, %s, 'k1') $$,
         :A, :AUD, (:'ch'::jsonb) ->> 'nonce', (:'ch'::jsonb) ->> 'challenge_exp', :P3, :SUBA, :now + 61, :now + 61 + 604800),
  '22023', NULL, 'V1: iat more than 60 s from the database clock is raised');
SELECT throws_ok(
  format($$ SELECT node_attestation_issue(%L, %L, decode(%L, 'hex'), %s, %L, %L, %s, %s, 'k1') $$,
         :A, :AUD, (:'ch'::jsonb) ->> 'nonce', (:'ch'::jsonb) ->> 'challenge_exp', :P3, :SUBA, :now, :now + 30 * 86400),
  '22023', NULL, 'V2: a lifetime other than exactly 7 days is raised');
RESET ROLE;

-- ── Per-account limit (D5): 3 distinct PeerIds ─────────────
-- Each issue below takes a fresh challenge first (:c).

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:A, :AUD) AS c \gset
SELECT is(node_attestation_issue(:A, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P3, :SUBA, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'Q1: A''s third PeerId (P3) is issued');
SELECT node_attestation_challenge(:A, :AUD) AS c \gset
SELECT is(node_attestation_issue(:A, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P4, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_QUOTA_EXCEEDED"}'::jsonb, 'Q2 (P0): A''s fourth PeerId (P4) is refused');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM node_attestation_issuances WHERE peer_id = :P4)
        + (SELECT count(*)::int FROM nodes WHERE peer_id = :P4), 0, 'Q3: the refusal recorded nothing for P4');

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:A, :AUD) AS c \gset
SELECT is(node_attestation_issue(:A, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P2, :SUBA, :now, :exp, 'k2'),
  '{"ok": true}'::jsonb, 'Q4: renewing P2 at the limit is allowed: the same PeerId takes no extra slot');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM node_attestation_issuances WHERE peer_id = :P2), 2, 'Q5: the renewal is a new log row');
SELECT is((SELECT cert_kid FROM nodes WHERE peer_id = :P2), 'k2', 'Q6: nodes points at the renewed certificate');

-- Deleting the nodes row frees nothing: the certificate still works on the network.
DELETE FROM nodes WHERE peer_id = :P3;
SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:A, :AUD) AS c \gset
SELECT is(node_attestation_issue(:A, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P4, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_QUOTA_EXCEEDED"}'::jsonb, 'Q7 (P0): deleting a nodes row does not free a slot');
RESET ROLE;

-- The log is append-only for every role, the table owner included.
SELECT throws_ok(format($$ DELETE FROM node_attestation_issuances WHERE peer_id = %L $$, :P3),
  '42501', NULL, 'Q8: deleting from the issuance log is refused');
SELECT throws_ok($$ UPDATE node_attestation_issuances SET exp = iat + 1 $$,
  '42501', NULL, 'Q9: updating the issuance log is refused');
SELECT throws_ok($$ TRUNCATE node_attestation_issuances $$,
  '42501', NULL, 'Q10: truncating the issuance log is refused');

-- A revoked certificate stops counting.
SELECT node_attestation_revoke(:P3, NULL, 'test: node replaced its identity.key');
SELECT node_attestation_challenge(:A, :AUD) AS c \gset
SELECT is(node_attestation_issue(:A, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P4, :SUBA, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'Q11: after P3 is revoked, A gets P4');
-- And a revoked PeerId cannot be issued again while the revocation covers the new iat.
SELECT node_attestation_challenge(:A, :AUD) AS c \gset
SELECT is(node_attestation_issue(:A, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P3, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_PEER_REVOKED"}'::jsonb, 'Q12: P3 revoked up to now cannot get a certificate born void');
RESET ROLE;

-- Expired certificates stop counting at exp + 60 s, not before.
-- B holds three certificates issued a week ago: P5 and P6 are past exp + 60 s,
-- P7 is exactly at it (exp + 60 = now), so only P7 is live.
INSERT INTO node_attestation_issuances (peer_id, user_id, iat, exp, kid) VALUES
  (:P5, :B, :now - 604800 - 100, :now - 100, 'k0'),
  (:P6, :B, :now - 604800 - 61, :now - 61, 'k0'),
  (:P7, :B, :now - 604800 - 60, :now - 60, 'k0');
SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:B, :AUD) AS c \gset
SELECT is(node_attestation_issue(:B, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P8, :SUBB, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'Q13: B (live: P7) gets P8');
SELECT node_attestation_challenge(:B, :AUD) AS c \gset
SELECT is(node_attestation_issue(:B, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P5, :SUBB, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'Q14: B (live: P7, P8) gets P5 again: P6, past exp + 60 s, does not count');
SELECT node_attestation_challenge(:B, :AUD) AS c \gset
SELECT is(node_attestation_issue(:B, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P6, :SUBB, :now, :exp, 'k1'),
  '{"error": "POR_QUOTA_EXCEEDED"}'::jsonb, 'Q15: B (live: P5, P7, P8) is refused P6: P7 at exactly exp + 60 s still counts');
RESET ROLE;

-- ── Rebinding a PeerId to another account ─────────────────

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('d0e55555-5555-4555-8555-555555555555', 'por-e@example.com', '{"user_name": "por_e"}'::jsonb);
\set E '''d0e55555-5555-4555-8555-555555555555'''
\set SUBE '''eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'''
-- A's certificate for P9 from 100 s ago, still live; A's P10 is past exp + 60 s.
INSERT INTO node_attestation_issuances (peer_id, user_id, iat, exp, kid) VALUES
  (:P9, :A, :now - 100, :now - 100 + 604800, 'k1'),
  (:P10, :A, :now - 604800 - 61, :now - 61, 'k0');

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:E, :AUD) AS c \gset
SELECT is(node_attestation_issue(:E, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P1, :SUBE, :now, :exp, 'k1'),
  '{"error": "POR_PEER_BOUND_ELSEWHERE"}'::jsonb, 'R1 (P0): E cannot take P1 while A''s certificate for it is live');
RESET ROLE;
SELECT is((SELECT user_id FROM nodes WHERE peer_id = :P1), :A::uuid, 'R2: P1 is still A''s');
SELECT is((SELECT count(*)::int FROM node_attestation_issuances WHERE peer_id = :P1 AND user_id = :E), 0, 'R3: nothing recorded for E');

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:E, :AUD) AS c \gset
SELECT is(node_attestation_issue(:E, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P9, :SUBE, :now, :exp, 'k1'),
  '{"error": "POR_PEER_BOUND_ELSEWHERE"}'::jsonb, 'R4: E cannot take P9 either');
SELECT node_attestation_revoke(:P9, :now - 50, 'test: A''s node key leaked');
SELECT node_attestation_challenge(:E, :AUD) AS c \gset
SELECT is(node_attestation_issue(:E, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P9, :SUBE, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'R5: once A''s certificate for P9 is revoked, E can take P9');
SELECT node_attestation_challenge(:E, :AUD) AS c \gset
SELECT is(node_attestation_issue(:E, :AUD, decode((:'c'::jsonb) ->> 'nonce', 'hex'), ((:'c'::jsonb) ->> 'challenge_exp')::bigint, :P10, :SUBE, :now, :exp, 'k1'),
  '{"ok": true}'::jsonb, 'R6: A''s expired certificate for P10 does not block E');
RESET ROLE;
SELECT results_eq(
  format($$ SELECT peer_id, user_id, sub FROM nodes WHERE peer_id IN (%L, %L) ORDER BY peer_id $$, :P9, :P10),
  format($$ VALUES (%L, %L::uuid, %L), (%L, %L::uuid, %L) $$, :P9, :E, :SUBE, :P10, :E, :SUBE),
  'R7: nodes now maps P9 and P10 to E');

-- ── Closed, banned and deleted accounts ───────────────────

SET LOCAL ROLE por_issuer;
SELECT node_attestation_challenge(:C, :AUD) AS cc \gset
RESET ROLE;
UPDATE profiles SET closed_at = now() WHERE id = :C;
SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_issue(:C, :AUD, decode((:'cc'::jsonb) ->> 'nonce', 'hex'), ((:'cc'::jsonb) ->> 'challenge_exp')::bigint, :PC, :SUBA, :now, :exp, 'k1'),
  '{"error": "POR_ACCOUNT_CLOSED"}'::jsonb, 'A1: an account closed after taking its challenge is refused at redemption');
SELECT is(node_attestation_challenge(:C, :AUD), '{"error": "POR_ACCOUNT_CLOSED"}'::jsonb, 'A2: a closed account gets no challenge');
RESET ROLE;

UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = :D;
SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_challenge(:D, :AUD), '{"error": "POR_ACCOUNT_CLOSED"}'::jsonb, 'A3: a banned account gets no challenge');
RESET ROLE;
UPDATE auth.users SET banned_until = now() - interval '1 second', deleted_at = now() WHERE id = :D;
SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_challenge(:D, :AUD), '{"error": "POR_ACCOUNT_CLOSED"}'::jsonb, 'A4: a soft-deleted account gets no challenge');
RESET ROLE;
UPDATE auth.users SET deleted_at = NULL WHERE id = :D;
SET LOCAL ROLE por_issuer;
SELECT ok(node_attestation_challenge(:D, :AUD) ? 'nonce', 'A5: a ban that has run out no longer blocks');

-- ── Open challenges per account: at most 5 ─────────────────

SELECT node_attestation_challenge(:E, :AUD) AS x \gset
SELECT node_attestation_challenge(:E, :AUD) AS x \gset
SELECT node_attestation_challenge(:E, :AUD) AS x \gset
SELECT node_attestation_challenge(:E, :AUD) AS x \gset
SELECT ok(node_attestation_challenge(:E, :AUD) ? 'nonce', 'CH1: the fifth open challenge is given');
SELECT is(node_attestation_challenge(:E, :AUD), '{"error": "POR_TOO_MANY_CHALLENGES"}'::jsonb, 'CH2: a sixth is refused');
RESET ROLE;
UPDATE node_attestation_challenges SET challenge_exp = :now - 1
 WHERE nonce = (SELECT nonce FROM node_attestation_challenges WHERE user_id = :E LIMIT 1);
SET LOCAL ROLE por_issuer;
SELECT ok(node_attestation_challenge(:E, :AUD) ? 'nonce', 'CH3: an expired challenge is cleared and frees its place');
RESET ROLE;

-- ── The account pseudonym is never a plain user id ────────

SELECT throws_ok(format($$ INSERT INTO nodes (peer_id, user_id, sub, cert_iat, cert_exp, cert_kid) VALUES (%L, %L, %L, 1, 2, 'k') $$, :PC, :A, :A),
  '23514', NULL, 'P1 (P0): nodes.sub refuses a UUID; only a 43-character base64url HMAC fits');

-- ── JWKS revocation list ──────────────────────────────────

INSERT INTO node_attestation_revocations (peer_id, not_after) VALUES
  (:P3, :now - 10),                 -- older entry for P3: the latest (now) wins
  (:P5, :now - 604800 - 60),        -- exactly at the edge: still needed
  (:P6, :now - 604800 - 61);        -- every token it voids has expired: dropped
SET LOCAL ROLE por_issuer;
SELECT is(node_attestation_revocations_for_jwks(),
  jsonb_build_array(
    jsonb_build_object('peer_id', :P3, 'not_after', :now),
    jsonb_build_object('peer_id', :P5, 'not_after', :now - 604800 - 60),
    jsonb_build_object('peer_id', :P9, 'not_after', :now - 50)),
  'J1: one entry per PeerId (latest not_after), dropped after not_after + 7 days + 60 s, sorted');
RESET ROLE;

-- ── RLS as the clients see it ─────────────────────────────
-- Last: request.jwt.claims stays set for the rest of the transaction.

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"d0e11111-1111-4111-8111-111111111111","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM nodes), 3, 'L1: A reads its own nodes (P1, P2, P4)');
SELECT is((SELECT count(*)::int FROM nodes WHERE user_id <> :A), 0, 'L2: A reads no one else''s nodes');
SET LOCAL request.jwt.claims = '{"sub":"d0e55555-5555-4555-8555-555555555555","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM nodes WHERE peer_id = :P1), 0, 'L3: E cannot see A''s P1');
SELECT is((SELECT count(*)::int FROM nodes), 2, 'L4: E reads its own two (P9, P10)');
SELECT throws_ok($$ SELECT count(*) FROM node_attestation_issuances $$, '42501', NULL, 'L5: authenticated cannot read the issuance log');
SELECT throws_ok($$ SELECT count(*) FROM node_attestation_challenges $$, '42501', NULL, 'L6: authenticated cannot read challenges');
SELECT throws_ok(format($$ INSERT INTO nodes (peer_id, user_id, sub, cert_iat, cert_exp, cert_kid) VALUES (%L, %L, %L, 1, 2, 'k') $$, :PC, :E, :SUBE),
  '42501', NULL, 'L7: authenticated cannot insert into nodes');
SELECT throws_ok(format($$ UPDATE nodes SET cert_exp = 1 WHERE peer_id = %L $$, :P9),
  '42501', NULL, 'L8: authenticated cannot update even its own nodes rows');
SELECT throws_ok(
  format($$ SELECT node_attestation_issue(%L, %L, decode(repeat('00', 32), 'hex'), 1, %L, %L, %s, %s, 'k1') $$, :E, :AUD, :P1, :SUBE, :now, :exp),
  '42501', NULL, 'L9: authenticated cannot call the record step and skip the signature check');
SELECT throws_ok(format($$ SELECT node_attestation_challenge(%L, %L) $$, :E, :AUD), '42501', NULL, 'L10: authenticated cannot mint challenges directly');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT count(*) FROM nodes $$, '42501', NULL, 'L11: anon cannot read nodes');
RESET ROLE;

-- The three internal tables are closed twice: no grant (L5, L6) and RLS with
-- no policy. Take the grant away for a moment (rolled back with the rest) to
-- check the second layer on its own: zero policies return zero rows.
SELECT ok((SELECT count(*) FROM node_attestation_issuances) > 0
      AND (SELECT count(*) FROM node_attestation_challenges) > 0
      AND (SELECT count(*) FROM node_attestation_revocations) > 0,
  'L12: the three internal tables hold rows, so the counts below are not empty by accident');
GRANT SELECT ON node_attestation_issuances, node_attestation_challenges, node_attestation_revocations TO authenticated;
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*)::int FROM node_attestation_issuances), 0, 'L13: with a stray grant, RLS still shows no issuance rows');
SELECT is((SELECT count(*)::int FROM node_attestation_challenges), 0, 'L14: with a stray grant, RLS still shows no challenges');
SELECT is((SELECT count(*)::int FROM node_attestation_revocations), 0, 'L15: with a stray grant, RLS still shows no revocations');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;

\else

SELECT plan(1);
SELECT skip('node attestation migration is deferred (supabase/migrations-deferred-v095-por/); apply it locally to run these tests', 1);
SELECT * FROM finish();

\endif
