-- ============================================================
-- pgTAP tests for get_arena_leaderboard (ADR-319 D4, plan 3.1)
-- File: supabase/tests/arena_leaderboard_tiers.sql
-- ============================================================
--
-- Migration 20260819190000. The read side finally consults invalidated_at —
-- until now the partial index built for that filter had no reader, so a
-- disqualified row still sat at the top of every list.
--
-- T7 and T8 carry the weight. A disqualified row must appear in
-- not_evaluated **with its reason**, not vanish: an author whose gene stopped
-- ranking needs to be able to see why without anyone announcing it, and that
-- is the whole point of putting the reason in the response. And
-- not_evaluated must carry no rank — sorting unmeasured numbers would hand
-- them back exactly the authority the tier just removed.
--
-- T9 pins one row per logical gene. Nine versions of one gene told the reader
-- nothing except that its author published often.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(12);

-- ------------------------------------------------------------
-- Fixture: two authors, genes covering every tier.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('c9111111-1111-4111-8111-111111111111', 'tier-a@example.com', '{"user_name": "tier_a"}'::jsonb),
  ('c9999999-9999-4999-8999-999999999999', 'tier-b@example.com', '{"user_name": "tier_b"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash, created_at) VALUES
  -- measured + enough callers  -> verified
  ('c9222222-2222-4222-8222-222222222222', 'c9111111-1111-4111-8111-111111111111',
   'tier-verified', 'test.tier', '0.1.0', 'Native',
   '{"domain":"test.tier","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('1',64), now() - interval '3 days'),
  -- measured + too few callers -> under_evaluation
  ('c9333333-3333-4333-8333-333333333333', 'c9111111-1111-4111-8111-111111111111',
   'tier-thin', 'test.tier', '0.1.0', 'Native',
   '{"domain":"test.tier","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('2',64), now() - interval '3 days'),
  -- estimated -> not_evaluated
  ('c9444444-4444-4444-8444-444444444444', 'c9111111-1111-4111-8111-111111111111',
   'tier-estimated', 'test.tier', '0.1.0', 'Wrapped',
   '{"domain":"test.tier","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('3',64), now() - interval '3 days'),
  -- disqualified -> not_evaluated, with reason
  ('c9555555-5555-4555-8555-555555555555', 'c9111111-1111-4111-8111-111111111111',
   'tier-dead', 'test.tier', '0.1.0', 'Native',
   '{"domain":"test.tier","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('4',64), now() - interval '3 days'),
  -- two versions of one logical gene: older is fine, newer is disqualified
  ('c9666666-6666-4666-8666-666666666666', 'c9999999-9999-4999-8999-999999999999',
   'tier-multi', 'test.tier', '0.1.0', 'Native',
   '{"domain":"test.tier","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('5',64), now() - interval '5 days'),
  ('c9777777-7777-4777-8777-777777777777', 'c9999999-9999-4999-8999-999999999999',
   'tier-multi', 'test.tier', '0.2.0', 'Native',
   '{"domain":"test.tier","inputSchema":{},"outputSchema":{},"version":"0.2.0"}'::jsonb, true, repeat('6',64), now() - interval '1 day');

INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, safety_score, evaluation_method, evaluation_n, invalidated_at, invalidation_reason) VALUES
  ('c9222222-2222-4222-8222-222222222222', 'test.tier', 0.90, 0.90, 1.0, 0.95, 'sandbox',   3, NULL, NULL),
  ('c9333333-3333-4333-8333-333333333333', 'test.tier', 0.95, 0.95, 1.0, 0.95, 'sandbox',   3, NULL, NULL),
  ('c9444444-4444-4444-8444-444444444444', 'test.tier', 0.99, 0.99, 1.0, 0.95, 'estimated', NULL, NULL, NULL),
  ('c9555555-5555-4555-8555-555555555555', 'test.tier', 1.00, 1.00, 1.0, 1.00, 'sandbox',   3, now(), 'async-express-artifact'),
  ('c9666666-6666-4666-8666-666666666666', 'test.tier', 0.60, 0.60, 1.0, 0.90, 'sandbox',   3, NULL, NULL),
  ('c9777777-7777-4777-8777-777777777777', 'test.tier', 0.85, 0.85, 1.0, 0.90, 'sandbox',   3, now(), 'async-express-artifact');

-- enough distinct callers only for tier-verified
INSERT INTO gene_contribution_metrics (gene_id, total_invocations, unique_callers) VALUES
  ('c9222222-2222-4222-8222-222222222222', 10, 4),
  ('c9333333-3333-4333-8333-333333333333', 10, 1);

-- T1: the threshold comes from the season config, not a literal
SELECT is(arena_min_unique_callers(), 2, 'T1: Rule 2 threshold is read from the active season config');

-- T2-T5: each row lands in the tier it earned
SELECT is((SELECT tier FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-verified'),
  'verified', 'T2: measured + enough distinct callers is verified');
SELECT is((SELECT tier FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-thin'),
  'under_evaluation', 'T3: measured but too few callers is under_evaluation');
SELECT is((SELECT tier FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-estimated'),
  'not_evaluated', 'T4: an estimate measured nothing — not_evaluated, not under_evaluation');
SELECT is((SELECT tier FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-dead'),
  'not_evaluated', 'T5: a disqualified row cannot rank, whatever its score said');

-- T6: the highest raw score in the fixture is a disqualified 1.00 — it must not lead
SELECT is((SELECT gene_name FROM get_arena_leaderboard('test.tier', 200, 0) LIMIT 1),
  'tier-verified', 'T6: the board leads with the verified row, not the highest number');

-- T7: a disqualified row is still visible, carrying its reason
SELECT is((SELECT invalidation_reason FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-dead'),
  'async-express-artifact',
  'T7: a disqualified row stays visible and says why — an author must be able to see the reason');

-- T8: not_evaluated carries no rank
SELECT is((SELECT count(*)::INT FROM get_arena_leaderboard('test.tier', 200, 0)
            WHERE tier = 'not_evaluated' AND tier_rank IS NOT NULL),
  0, 'T8: not_evaluated rows carry no rank — unmeasured numbers get no order');

-- T9-T10: one row per logical gene, preferring a version still standing
SELECT is((SELECT count(*)::INT FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-multi'),
  1, 'T9: one row per logical gene, not one per version');
SELECT is((SELECT gene_version FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-multi'),
  '0.1.0',
  'T10: the newest version that still stands wins over a newer disqualified one');
SELECT is((SELECT versions_on_board FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-multi'),
  2::BIGINT, 'T11: the collapsed versions are still counted, not hidden');

-- T12: the dual-column contract survives the RPC (§33.1)
SELECT is((SELECT base_fitness FROM get_arena_leaderboard('test.tier', 200, 0) WHERE gene_name = 'tier-verified'),
  0.90::DOUBLE PRECISION, 'T12: base_fitness travels with the row alongside the discounted F(g)');

SELECT * FROM finish();
ROLLBACK;
