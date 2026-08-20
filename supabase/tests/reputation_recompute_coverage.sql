-- ============================================================
-- pgTAP: an owner who loses every gene must not keep a score
-- File: supabase/tests/reputation_recompute_coverage.sql
-- ============================================================
--
-- Migration 20260819270000. `recompute_all_published_reputation()` iterated
-- owners of currently-published genes, so an owner who had one and no longer
-- does was never visited and kept whatever score was last written.
--
-- Found in production: the ADR-323 ownership move emptied
-- `rotifer-protocol-legacy` and the creators leaderboard came out showing two
-- entries at 0.1324 — the live identity, correctly, and a ghost owning
-- nothing. Same class as the Arena board that kept ranking invalidated rows:
-- the read path reflecting a state the data no longer supports.
--
-- T3 is the test that matters and the one that did not exist. T4 guards the
-- other direction, because the obvious fix — iterate `developer_reputation`
-- instead of `genes` — would silently stop covering owners who have genes but
-- no score row yet.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(4);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f9111111-1111-4111-8111-111111111111', 'emptied@example.com', '{"user_name": "emptied_owner"}'::jsonb),
  ('f9222222-2222-4222-8222-222222222222', 'keeper@example.com',  '{"user_name": "keeping_owner"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f9333333-3333-4333-8333-333333333333', 'f9111111-1111-4111-8111-111111111111',
   'to-be-moved', 'test.cov', '0.1.0', 'Native',
   '{"domain":"test.cov","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('7',64)),
  ('f9444444-4444-4444-8444-444444444444', 'f9222222-2222-4222-8222-222222222222',
   'stays-put', 'test.cov', '0.1.0', 'Native',
   '{"domain":"test.cov","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('8',64));

-- Give the soon-to-be-emptied owner a score worth losing.
INSERT INTO arena_entries (gene_id, domain, fitness_value, safety_score, evaluation_method, total_calls)
VALUES ('f9333333-3333-4333-8333-333333333333', 'test.cov', 0.90, 0.95, 'sandbox', 0);

SELECT recompute_all_published_reputation();

SELECT cmp_ok(
  (SELECT score FROM developer_reputation WHERE user_id = 'f9111111-1111-4111-8111-111111111111'),
  '>', 0::DOUBLE PRECISION,
  'T1: an owner with a measured gene has a score to begin with');

SELECT cmp_ok(
  (SELECT score FROM developer_reputation WHERE user_id = 'f9222222-2222-4222-8222-222222222222'),
  '>=', 0::DOUBLE PRECISION,
  'T2: the other owner has a reputation row too');

-- Move the gene away, exactly as ADR-323 did — including having to switch the
-- guards off, which is itself part of "exactly as ADR-323 did". Rolled back
-- with the rest of the transaction.
ALTER TABLE genes DISABLE TRIGGER trg_version_immutability;
ALTER TABLE genes DISABLE TRIGGER trg_genes_check_prev_version;
UPDATE genes SET owner_id = 'f9222222-2222-4222-8222-222222222222'
 WHERE id = 'f9333333-3333-4333-8333-333333333333';
ALTER TABLE genes ENABLE TRIGGER trg_version_immutability;
ALTER TABLE genes ENABLE TRIGGER trg_genes_check_prev_version;

SELECT recompute_all_published_reputation();

SELECT is(
  (SELECT score FROM developer_reputation WHERE user_id = 'f9111111-1111-4111-8111-111111111111'),
  0::DOUBLE PRECISION,
  'T3: an owner who lost every gene drops to zero — no ghost on the leaderboard');

-- T4: the other direction. An owner with genes but no reputation row yet must
-- still be visited; iterating developer_reputation alone would miss them.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('f9555555-5555-4555-8555-555555555555', 'fresh@example.com', '{"user_name": "fresh_owner"}'::jsonb);
INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash) VALUES
  ('f9666666-6666-4666-8666-666666666666', 'f9555555-5555-4555-8555-555555555555',
   'brand-new', 'test.cov', '0.1.0', 'Native',
   '{"domain":"test.cov","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb, true, repeat('c',64));
DELETE FROM developer_reputation WHERE user_id = 'f9555555-5555-4555-8555-555555555555';

SELECT recompute_all_published_reputation();

SELECT isnt(
  (SELECT score FROM developer_reputation WHERE user_id = 'f9555555-5555-4555-8555-555555555555'),
  NULL,
  'T4: an owner with genes but no score row yet is still recomputed');

SELECT * FROM finish();
ROLLBACK;
