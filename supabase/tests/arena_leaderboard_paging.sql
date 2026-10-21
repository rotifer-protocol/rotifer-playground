-- ============================================================
-- pgTAP tests for paging through get_arena_leaderboard
-- File: supabase/tests/arena_leaderboard_paging.sql
-- ============================================================
--
-- `rotifer genome import` reads the leaderboard page by page (LIMIT/OFFSET).
-- The board was ordered by tier, domain, fitness_value only, so rows with
-- equal fitness had no defined order between pages: a row could
-- appear on two pages and another on none. Measured before the fix on this
-- fixture (two groups of tied rows, 30 in all, pages of 7): 30 rows read,
-- 29 distinct — one row read twice, one never. A missed row
-- is a missed import candidate. Migration 20261020140000 adds gene_id as the
-- last sort key.
--
-- Run inside the supabase test container:
--   supabase test db

BEGIN;

SELECT plan(3);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('e1111111-1111-4111-8111-111111111111', 'paging@example.com', '{"user_name": "paging_author"}'::jsonb);

-- 30 published genes in one domain, all in the same tier (estimated ->
-- not_evaluated), in two groups of tied fitness: 20 at 0.5, 10 at 0.3.
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
SELECT ('e0000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
       'e1111111-1111-4111-8111-111111111111', 'paging-' || i, 'test.paging', '0.1.0', 'Native',
       '{"domain":"test.paging"}'::jsonb, true, lpad(to_hex(1000 + i), 64, '0')
  FROM generate_series(1, 30) i;

INSERT INTO arena_entries (gene_id, domain, fitness_value, base_fitness, fidelity_discount, safety_score, evaluation_method, evaluation_n)
SELECT ('e0000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, 'test.paging',
       CASE WHEN i <= 20 THEN 0.5 ELSE 0.3 END, CASE WHEN i <= 20 THEN 0.5 ELSE 0.3 END, 1.0, 0.9, 'estimated', NULL
  FROM generate_series(1, 30) i;

-- Read the board 7 rows at a time until it runs out (5 pages cover 30).
CREATE TEMP TABLE paged AS
SELECT p, lb.gene_id, ord
  FROM generate_series(0, 4) p,
       LATERAL get_arena_leaderboard('test.paging', 7, p * 7) WITH ORDINALITY AS lb(
         tier, tier_rank, gene_id, gene_name, gene_version, owner_username, domain, fidelity,
         fitness_value, base_fitness, fidelity_discount, safety_score, evaluation_method,
         evaluation_n, unique_callers, invalidation_reason, total_calls, last_evaluated,
         versions_on_board, ord);

SELECT is((SELECT count(*)::int FROM paged), 30,
  'paging reads exactly as many rows as the board has');

SELECT is((SELECT count(DISTINCT gene_id)::int FROM paged), 30,
  'no row is read twice and none is skipped across pages');

-- And the order is the defined total order: fitness first, then gene_id.
SELECT is(
  (SELECT array_agg(gene_id ORDER BY p, ord) FROM paged),
  (SELECT array_agg(g.id ORDER BY ae.fitness_value DESC, g.id)
     FROM genes g JOIN arena_entries ae ON ae.gene_id = g.id
    WHERE g.domain = 'test.paging'),
  'pages follow tier, domain, fitness, then gene_id'
);

SELECT * FROM finish();
ROLLBACK;
