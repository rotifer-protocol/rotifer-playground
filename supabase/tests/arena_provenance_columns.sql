-- ============================================================
-- pgTAP tests for arena_entries provenance columns (ADR-319 D2)
-- File: supabase/tests/arena_provenance_columns.sql
-- ============================================================
--
-- Migration 20260818150000. These columns exist to answer "where did this
-- score come from", which the Arena could not answer at all: a sandbox
-- measurement, an estimate, and a number typed in by hand were stored
-- identically and ranked against each other.
--
-- The assertions worth caring about are T5 and T7. T5 pins that a row which
-- forgets to declare a method lands in 'unknown-legacy' rather than something
-- rankable — the schema has to fail closed, because a writer that forgets is
-- exactly the case this vocabulary exists to catch. T7 pins that an
-- invalidation cannot exist without a reason, which is the schema-level half
-- of the ADR-319 D6 governance rule against reaching in and changing ranks.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(12);

-- ------------------------------------------------------------
-- Fixture: one author, one published gene, one arena entry.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('e1111111-1111-4111-8111-111111111111', 'prov-test@example.com',
        '{"user_name": "prov_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('e2222222-2222-4222-8222-222222222222',
        'e1111111-1111-4111-8111-111111111111',
        'prov-test-gene', 'test.prov', '0.1.0', 'Wrapped',
        '{"domain":"test.prov","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('f', 64));

-- T1–T5 — the columns exist with the intended shape
SELECT has_column('public', 'arena_entries', 'evaluation_method',   'T1: evaluation_method exists');
SELECT has_column('public', 'arena_entries', 'evaluation_n',        'T2: evaluation_n exists');
SELECT has_column('public', 'arena_entries', 'evaluator',           'T3: evaluator exists');
SELECT has_column('public', 'arena_entries', 'invalidated_at',      'T4: invalidated_at exists');
SELECT has_column('public', 'arena_entries', 'invalidation_reason', 'T5: invalidation_reason exists');

SELECT col_not_null('public', 'arena_entries', 'evaluation_method',
  'T6: evaluation_method is NOT NULL — provenance is never simply absent');

-- T7 — a writer that forgets fails closed, into the tier that does not rank
INSERT INTO arena_entries (gene_id, domain, fitness_value)
VALUES ('e2222222-2222-4222-8222-222222222222', 'test.prov', 0.5);
SELECT is(
  (SELECT evaluation_method FROM arena_entries WHERE gene_id = 'e2222222-2222-4222-8222-222222222222'),
  'unknown-legacy',
  'T7: a row written without declaring a method lands in unknown-legacy, not in a rankable tier');

-- T8 — unknown n stays unknown; nobody should read it as 1
SELECT is(
  (SELECT evaluation_n FROM arena_entries WHERE gene_id = 'e2222222-2222-4222-8222-222222222222'),
  NULL::INTEGER,
  'T8: evaluation_n defaults to NULL (unknown), not to a number');

-- T9 — the vocabulary is closed
SELECT throws_ok(
  $$ UPDATE arena_entries SET evaluation_method = 'vibes'
      WHERE gene_id = 'e2222222-2222-4222-8222-222222222222' $$,
  '23514',
  NULL,
  'T9: an undefined evaluation_method is rejected');

-- T10 — every defined value is accepted (guards against a typo in the CHECK)
SELECT lives_ok(
  $$ UPDATE arena_entries SET evaluation_method = 'binding_runtime'
      WHERE gene_id = 'e2222222-2222-4222-8222-222222222222' $$,
  'T10: the defined vocabulary is accepted');

-- T11 — an invalidation without a reason cannot exist
SELECT throws_ok(
  $$ UPDATE arena_entries SET invalidated_at = now()
      WHERE gene_id = 'e2222222-2222-4222-8222-222222222222' $$,
  '23514',
  NULL,
  'T11: invalidating without naming a reason is rejected (ADR-319 D6)');

-- T12 — invalidation with a reason is fine, and the row survives (never deleted)
SELECT lives_ok(
  $$ UPDATE arena_entries
        SET invalidated_at = now(), invalidation_reason = 'async-express-artifact'
      WHERE gene_id = 'e2222222-2222-4222-8222-222222222222' $$,
  'T12: invalidation with a documented reason is accepted, and the row stays');

SELECT * FROM finish();

ROLLBACK;
