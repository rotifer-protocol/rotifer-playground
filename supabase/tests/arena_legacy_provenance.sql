-- ============================================================
-- pgTAP tests for classify_legacy_evaluation / the 2.7 backfill
-- File: supabase/tests/arena_legacy_provenance.sql
-- ============================================================
--
-- Migration 20260819140000. The classifier infers how a pre-provenance row was
-- produced from the shape of its numbers. Every tuple below is a real
-- production row (values copied verbatim), one or more per bucket, plus the
-- negatives that matter: a measured float that must NOT pass as an estimate,
-- and an off-congruence thousandth tuple that must NOT either.
--
-- T10-T12 are the ones that carry weight: the backfill must touch only rows
-- still marked unknown-legacy, must leave real provenance alone, and must be a
-- no-op the second time. A backfill that could overwrite a measured row's
-- 'sandbox' with an inferred 'estimated' would be the hand-edit ADR-319 D6
-- forbids, wearing a migration's clothes.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(14);

-- helper: just the method
CREATE OR REPLACE FUNCTION _m(f DOUBLE PRECISION, s DOUBLE PRECISION, su DOUBLE PRECISION, l DOUBLE PRECISION, r DOUBLE PRECISION)
RETURNS TEXT LANGUAGE sql AS $$ SELECT (classify_legacy_evaluation(f, s, su, l, r)).method $$;

-- T1: the publish placeholder, exact tuple (28 production rows)
SELECT is(_m(0.5, 1, 1, 0.8, 0.8), 'declared', 'T1: publish-default tuple is declared');

-- T2: pre-ADR-318 sandbox cap (6 production rows) — lat/res are measured floats
SELECT is(_m(1.0, 1, 1, 0.406393931183961, 2.14190548032985e-06), 'sandbox', 'T2: fitness 1.0 + success 1 is sandbox');

-- T3: hash estimate, Native base, latency in the positive-int32 range (genesis-web-search)
SELECT is(_m(0.869, 0.869, 0.969, 0.995, 0.718), 'estimated', 'T3: Native-base hash estimate');

-- T4: hash estimate whose seed went negative under JS >> — latency below 0.7 (citation-manager)
SELECT is(_m(0.928, 0.878, 0.978, 0.651, 0.494), 'estimated', 'T4: hash estimate with negative-int32 latency/resource still recognised');

-- T5: hash estimate, Wrapped base (translator)
SELECT is(_m(0.599, 0.899, 0.999, 0.731, 0.761), 'estimated', 'T5: Wrapped-base hash estimate');

-- T6: the old MCP direct submit — round hundredths everywhere (hook-guard)
SELECT is(_m(0.81, 1.0, 0.97, 0.92, 0.95), 'declared', 'T6: hand-shaped hundredths are declared');

-- T7: a genuinely measured row must not be mistaken for an estimate
SELECT is(_m(0.7321, 0.91, 0.6667, 0.4817, 0.9123), 'unknown-legacy', 'T7: a measured float fits no fingerprint');

-- T8: thousandths in range but fitness/success not congruent mod 50 — not the estimator
SELECT is(_m(0.869, 0.869, 0.970, 0.995, 0.718), 'unknown-legacy', 'T8: off-congruence thousandths are not an estimate');

-- T9: NULL dimension never classifies
SELECT is(_m(0.869, NULL, NULL, 0.995, 0.718), 'unknown-legacy', 'T9: missing dimensions stay unknown');

-- ------------------------------------------------------------
-- Fixture for the backfill semantics
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('a7111111-1111-4111-8111-111111111111', 'legacy-test@example.com',
        '{"user_name": "legacy_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('a7222222-2222-4222-8222-222222222222', 'a7111111-1111-4111-8111-111111111111',
        'legacy-a', 'test.legacy', '0.1.0', 'Wrapped',
        '{"domain":"test.legacy","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('1', 64)),
       ('a7333333-3333-4333-8333-333333333333', 'a7111111-1111-4111-8111-111111111111',
        'legacy-b', 'test.legacy', '0.1.0', 'Wrapped',
        '{"domain":"test.legacy","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('2', 64)),
       ('a7444444-4444-4444-8444-444444444444', 'a7111111-1111-4111-8111-111111111111',
        'legacy-c', 'test.legacy', '0.1.0', 'Wrapped',
        '{"domain":"test.legacy","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('3', 64));

-- a: unknown-legacy with the publish tuple → should become declared
-- b: already 'sandbox' with a tuple the classifier would call estimated → must NOT change
-- c: unknown-legacy with a measured float → must stay unknown-legacy
INSERT INTO arena_entries (gene_id, domain, fitness_value, safety_score, success_rate, latency_score, resource_efficiency, evaluation_method)
VALUES ('a7222222-2222-4222-8222-222222222222', 'test.legacy', 0.5, 1, 1, 0.8, 0.8, 'unknown-legacy'),
       ('a7333333-3333-4333-8333-333333333333', 'test.legacy', 0.869, 0.869, 0.969, 0.995, 0.718, 'sandbox'),
       ('a7444444-4444-4444-8444-444444444444', 'test.legacy', 0.7321, 0.91, 0.6667, 0.4817, 0.9123, 'unknown-legacy');

-- Re-run exactly the migration's UPDATE
UPDATE arena_entries a
   SET evaluation_method = c.method
  FROM (
    SELECT e.id,
           (classify_legacy_evaluation(e.fitness_value, e.safety_score, e.success_rate, e.latency_score, e.resource_efficiency)).method AS method
      FROM arena_entries e
     WHERE e.evaluation_method = 'unknown-legacy'
  ) AS c
 WHERE c.id = a.id AND a.evaluation_method = 'unknown-legacy' AND c.method <> 'unknown-legacy';

SELECT is((SELECT evaluation_method FROM arena_entries WHERE gene_id = 'a7222222-2222-4222-8222-222222222222'),
  'declared', 'T10: an unknown-legacy row with a fingerprint is backfilled');
SELECT is((SELECT evaluation_method FROM arena_entries WHERE gene_id = 'a7333333-3333-4333-8333-333333333333'),
  'sandbox', 'T11: a row that already records real provenance is never overwritten');
SELECT is((SELECT evaluation_method FROM arena_entries WHERE gene_id = 'a7444444-4444-4444-8444-444444444444'),
  'unknown-legacy', 'T12: a row with no fingerprint stays unknown-legacy');

-- T13: the probe view agrees with the ledger for the backfilled row
SELECT is((SELECT inferred_method FROM arena_legacy_provenance_probe WHERE gene_id = 'a7222222-2222-4222-8222-222222222222'),
  'declared', 'T13: the public probe explains the label the ledger now carries');

-- T14: the probe is readable by anon (it is the reader's evidence, not ours)
SELECT ok(has_table_privilege('anon', 'arena_legacy_provenance_probe', 'SELECT'),
  'T14: anon can read the provenance probe');

DROP FUNCTION _m(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);
SELECT * FROM finish();
ROLLBACK;
