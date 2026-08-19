-- ============================================================
-- pgTAP tests for R(g) reading the invalidation (ADR-319 D4)
-- File: supabase/tests/reputation_invalidation_gate.sql
-- ============================================================
--
-- Migration 20260819230000. The leaderboard stopped ranking disqualified
-- entries; R(g) kept spending them. Under the current ecosystem weights the
-- arena term carries 0.70, so this was most of the number: production's
-- `hook-guard` showed Score 0.60, of which 0.567 came from a fitness value
-- invalidated as `async-express-artifact`, on a page where its F(g) already
-- read "—".
--
-- T3 and T8 carry the weight. T3 is the whole point — a disqualified entry
-- must contribute nothing to reputation. T8 pins the predicate against
-- `get_arena_leaderboard`: the same rule now lives in the board's tiering and
-- in R(g), and one rule with two implementations is where the last three
-- defects in this area came from.
--
-- T9 covers the trigger. Invalidation is an UPDATE and every existing
-- reputation trigger fires on INSERT, which is exactly why 57 rows were
-- disqualified earlier today without R(g) noticing.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(11);

-- ------------------------------------------------------------
-- Fixture. Downloads stay 0 throughout so the usage term is out of the way
-- and the arena/stability terms are readable on their own.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('e1111111-1111-4111-8111-111111111111', 'rep-a@example.com', '{"user_name": "rep_a"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('e2222222-2222-4222-8222-222222222222', 'e1111111-1111-4111-8111-111111111111',
   'rep-measured', 'test.rep', '0.1.0', 'Native',
   '{"domain":"test.rep","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('a',64)),
  ('e3333333-3333-4333-8333-333333333333', 'e1111111-1111-4111-8111-111111111111',
   'rep-dead', 'test.rep', '0.1.0', 'Native',
   '{"domain":"test.rep","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('b',64)),
  ('e4444444-4444-4444-8444-444444444444', 'e1111111-1111-4111-8111-111111111111',
   'rep-estimated', 'test.rep', '0.1.0', 'Wrapped',
   '{"domain":"test.rep","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('c',64));

-- The published-gene trigger already ran compute_gene_reputation on each of
-- the three above with no arena rows; the entries land next.
INSERT INTO arena_entries (gene_id, domain, fitness_value, safety_score, evaluation_method, total_calls, invalidated_at, invalidation_reason) VALUES
  ('e2222222-2222-4222-8222-222222222222', 'test.rep', 0.80, 0.95, 'sandbox',   0, NULL, NULL),
  ('e3333333-3333-4333-8333-333333333333', 'test.rep', 1.00, 1.00, 'sandbox',   0, now(), 'async-express-artifact'),
  ('e4444444-4444-4444-8444-444444444444', 'test.rep', 0.99, 0.95, 'estimated', 0, NULL, NULL);

-- ------------------------------------------------------------
-- T1-T2: the predicate says what a measurement is
-- ------------------------------------------------------------
SELECT ok(arena_entry_is_measured('sandbox') AND arena_entry_is_measured('binding_runtime'),
  'T1: a sandbox or binding-runtime run counts as measured');
SELECT ok(NOT arena_entry_is_measured('estimated')
      AND NOT arena_entry_is_measured('declared')
      AND NOT arena_entry_is_measured('unknown-legacy'),
  'T2: an estimate, a client-declared number and a legacy row are not measurements');

-- ------------------------------------------------------------
-- T3-T5: what reaches the arena term of R(g)
-- Weights with ecosystem downloads at 0: arena 0.70, usage 0.05, stability 0.25.
-- ------------------------------------------------------------
-- Compared with a tolerance: the function multiplies double precision, while
-- a bare SQL literal folds in numeric and lands on a different last bit.
SELECT ok(abs(compute_gene_reputation('e2222222-2222-4222-8222-222222222222')
              - (0.70::DOUBLE PRECISION * 0.80::DOUBLE PRECISION)) < 1e-12,
  'T3a: a standing sandbox measurement still contributes its fitness');

SELECT is(compute_gene_reputation('e3333333-3333-4333-8333-333333333333'),
  0.0::DOUBLE PRECISION,
  'T3: a disqualified entry contributes nothing — not even its 1.00');

SELECT is(compute_gene_reputation('e4444444-4444-4444-8444-444444444444'),
  0.0::DOUBLE PRECISION,
  'T4: an estimate contributes nothing — a content hash is not a measurement');

-- The gene_reputation ledger has to agree with the returned score; a caller
-- reading the breakdown must not see an arena_score the total never spent.
SELECT is((SELECT arena_score FROM gene_reputation
            WHERE gene_id = 'e3333333-3333-4333-8333-333333333333'
            ORDER BY epoch DESC LIMIT 1),
  0.0::DOUBLE PRECISION,
  'T5: the recorded breakdown agrees — arena_score is 0, not a withheld 1.00');

-- ------------------------------------------------------------
-- T6-T7: stability
-- ------------------------------------------------------------
UPDATE arena_entries SET total_calls = 1
 WHERE gene_id = 'e4444444-4444-4444-8444-444444444444';
SELECT ok(abs(compute_gene_reputation('e4444444-4444-4444-8444-444444444444')
              - (0.25::DOUBLE PRECISION * (ln(2.0::DOUBLE PRECISION) / ln(101.0::DOUBLE PRECISION)))) < 1e-12,
  'T6: calls on an estimated entry still count as stability — how the fitness was derived says nothing about whether calls happened');

UPDATE arena_entries SET total_calls = 100
 WHERE gene_id = 'e3333333-3333-4333-8333-333333333333';
SELECT is(compute_gene_reputation('e3333333-3333-4333-8333-333333333333'),
  0.0::DOUBLE PRECISION,
  'T7: calls booked against a disqualified entry are not evidence of stability');

-- ------------------------------------------------------------
-- T8: one rule, not two implementations
-- ------------------------------------------------------------
SELECT is(
  (SELECT count(*)::INT FROM get_arena_leaderboard('test.rep', 200, 0) lb
     JOIN genes g ON g.id = lb.gene_id
     JOIN arena_entries ae ON ae.gene_id = g.id
    WHERE (lb.tier <> 'not_evaluated')
      <> (ae.invalidated_at IS NULL AND arena_entry_is_measured(ae.evaluation_method))),
  0,
  'T8: the board ranks exactly the entries R(g) is willing to spend — one rule, no drift');

-- ------------------------------------------------------------
-- T9: invalidation propagates without anyone remembering to run something
-- ------------------------------------------------------------
UPDATE arena_entries SET total_calls = 0
 WHERE gene_id = 'e2222222-2222-4222-8222-222222222222';
SELECT compute_gene_reputation('e2222222-2222-4222-8222-222222222222');

UPDATE arena_entries SET invalidated_at = now(), invalidation_reason = 'test-data'
 WHERE gene_id = 'e2222222-2222-4222-8222-222222222222';

SELECT is((SELECT reputation_score FROM genes WHERE id = 'e2222222-2222-4222-8222-222222222222'),
  0.0::DOUBLE PRECISION,
  'T9: invalidating an entry drops the gene score on its own — the UPDATE trigger closes the gap that let 57 rows pass unnoticed');

-- ------------------------------------------------------------
-- T10: the backfill exists but stays out of the migration's way
-- ------------------------------------------------------------
SELECT ok((SELECT genes_recomputed FROM recompute_all_published_reputation()) >= 3,
  'T10: the backfill is callable on demand and reports what it touched');

SELECT * FROM finish();
ROLLBACK;
