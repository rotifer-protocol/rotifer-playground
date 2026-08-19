-- ============================================================
-- pgTAP tests for the §33.1 dual-column fitness contract
-- File: supabase/tests/arena_dual_column.sql
-- ============================================================
--
-- Migration 20260819120000. Spec §5.1 (v2.11) defines
--   F(g) = base_fitness × FIDELITY_DISCOUNT[fidelity]
-- and §33.1 asks the Arena to show both numbers. The ledger now carries both,
-- plus the discount that was in force, so the multiplication is reconstructible
-- from the row (§9.7.1) after the protocol parameter moves.
--
-- T5/T6 are the ones that carry weight. A base without its discount, or a
-- discount without its base, reconstructs nothing — the pair constraint is
-- what makes the column honest rather than decorative. And pre-existing rows
-- stay NULL: writing base = fitness_value, discount = 1.0 onto them would be
-- inventing provenance for rows that are already 'unknown-legacy'.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(9);

-- ------------------------------------------------------------
-- Fixture: one author, one published gene. Rolled back at the end.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('f1111111-1111-4111-8111-111111111111', 'dual-test@example.com',
        '{"user_name": "dual_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('f2222222-2222-4222-8222-222222222222',
        'f1111111-1111-4111-8111-111111111111',
        'dual-test-gene', 'test.dual', '0.1.0', 'Hybrid',
        '{"domain":"test.dual","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('a', 64));

-- T1-T2: the columns exist
SELECT has_column('public', 'arena_entries', 'base_fitness',      'T1: base_fitness exists');
SELECT has_column('public', 'arena_entries', 'fidelity_discount', 'T2: fidelity_discount exists');

-- T3: a row that records the pair is accepted, and the multiplication holds
INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, evaluation_method)
VALUES ('f2222222-2222-4222-8222-222222222222', 'test.dual', 0.595, 0.70, 0.85, 'estimated');

SELECT is(
  (SELECT round((base_fitness * fidelity_discount)::numeric, 4)
     FROM arena_entries WHERE gene_id = 'f2222222-2222-4222-8222-222222222222'),
  0.5950,
  'T3: fitness_value is reconstructible as base_fitness × fidelity_discount'
);

-- T4: a row written without the pair stays NULL — not defaulted to 1.0
DELETE FROM arena_entries WHERE gene_id = 'f2222222-2222-4222-8222-222222222222';
INSERT INTO arena_entries (gene_id, domain, fitness_value)
VALUES ('f2222222-2222-4222-8222-222222222222', 'test.dual', 0.5);

SELECT is(
  (SELECT base_fitness FROM arena_entries WHERE gene_id = 'f2222222-2222-4222-8222-222222222222'),
  NULL::DOUBLE PRECISION,
  'T4: a legacy-shaped write leaves base_fitness NULL — unknown stays unknown'
);

-- T5-T6: half a pair is refused
PREPARE base_only AS
  UPDATE arena_entries SET base_fitness = 0.7, fidelity_discount = NULL
   WHERE gene_id = 'f2222222-2222-4222-8222-222222222222';
SELECT throws_ok('base_only', '23514',
  'new row for relation "arena_entries" violates check constraint "chk_arena_dual_column_pair"',
  'T5: base_fitness without fidelity_discount is refused');

PREPARE discount_only AS
  UPDATE arena_entries SET base_fitness = NULL, fidelity_discount = 0.85
   WHERE gene_id = 'f2222222-2222-4222-8222-222222222222';
SELECT throws_ok('discount_only', '23514',
  'new row for relation "arena_entries" violates check constraint "chk_arena_dual_column_pair"',
  'T6: fidelity_discount without base_fitness is refused');

-- T7-T8: the discount must be a discount
PREPARE discount_zero AS
  UPDATE arena_entries SET base_fitness = 0.7, fidelity_discount = 0
   WHERE gene_id = 'f2222222-2222-4222-8222-222222222222';
SELECT throws_ok('discount_zero', '23514',
  'new row for relation "arena_entries" violates check constraint "chk_arena_fidelity_discount_range"',
  'T7: a zero discount is not a discount');

PREPARE discount_over AS
  UPDATE arena_entries SET base_fitness = 0.7, fidelity_discount = 1.2
   WHERE gene_id = 'f2222222-2222-4222-8222-222222222222';
SELECT throws_ok('discount_over', '23514',
  'new row for relation "arena_entries" violates check constraint "chk_arena_fidelity_discount_range"',
  'T8: a discount above 1 is not a discount');

-- T9: the protocol-default 1.00 for Native is a legal pair (not excluded by the > 0 bound)
UPDATE arena_entries SET base_fitness = 0.9, fidelity_discount = 1.0
 WHERE gene_id = 'f2222222-2222-4222-8222-222222222222';
SELECT is(
  (SELECT fidelity_discount FROM arena_entries WHERE gene_id = 'f2222222-2222-4222-8222-222222222222'),
  1.0::DOUBLE PRECISION,
  'T9: the Native discount of exactly 1.0 is accepted'
);

SELECT * FROM finish();
ROLLBACK;
