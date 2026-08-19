-- ============================================================
-- pgTAP tests for gene_invocation_duplicate_probe (ADR-322 D3)
-- File: supabase/tests/invocation_duplicate_probe.sql
-- ============================================================
--
-- Migration 20260819100000. The probe exists because the double-reporting
-- defect survived for months not by being subtle but by nobody looking. A
-- probe nobody can trust is the same thing again, so what these tests protect
-- is mostly the ways it could quietly stop telling the truth.
--
-- T7 is the one that matters most: it pins the guard and the probe to the
-- *same* window behaviourally, not just textually. Two rows written inside
-- the window collapse to one, so the probe finds nothing; two rows written
-- outside it stay two, and the probe still finds nothing. If the guard and
-- the probe ever disagree about how wide the window is, one of those two
-- assertions breaks. A probe that silently uses a different threshold than
-- the thing it checks would report zero while duplicates flowed.
--
-- T8/T9 pin the pre-guard split. Two duplicate pairs already exist in
-- production, written hours before D1 landed, and ADR-322 D4 keeps them:
-- they are real history, and hand-editing the ledger is what ADR-319 D6
-- forbids. But counting them would leave the probe permanently red, and a
-- permanently red probe teaches everyone to ignore it.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(12);

-- ------------------------------------------------------------
-- Fixture: one author, two published genes. Rolled back at the end.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('d1111111-1111-4111-8111-111111111111', 'probe-test@example.com',
        '{"user_name": "probe_test"}'::jsonb);

INSERT INTO genes (id, owner_id, name, domain, version, fidelity, phenotype, published, content_hash)
VALUES ('d2222222-2222-4222-8222-222222222222',
        'd1111111-1111-4111-8111-111111111111',
        'probe-test-gene', 'test.probe', '0.1.0', 'Wrapped',
        '{"domain":"test.probe","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('d', 64)),
       ('d3333333-3333-4333-8333-333333333333',
        'd1111111-1111-4111-8111-111111111111',
        'probe-test-other', 'test.probe', '0.1.0', 'Wrapped',
        '{"domain":"test.probe","inputSchema":{},"outputSchema":{},"version":"0.1.0"}'::jsonb,
        true, repeat('e', 64));

-- ------------------------------------------------------------
-- T1-T2: the shared window exists and is what D1 documented.
-- ------------------------------------------------------------
SELECT has_function('public', 'invocation_dedup_window', 'dedup window is a named, single definition');
SELECT is(invocation_dedup_window(), INTERVAL '5 seconds', 'window is the 5 seconds ADR-322 D1 argued for');

SELECT has_function('public', 'invocation_dedup_guard_since', 'guard activation instant is named, not inlined');

-- ------------------------------------------------------------
-- T4: an empty ledger produces an empty probe. A probe that reported
-- something on no data would be noise from day one.
-- ------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE gene_id IN ('d2222222-2222-4222-8222-222222222222',
                      'd3333333-3333-4333-8333-333333333333'))::INT,
  0,
  'no invocations, no findings'
);

-- ------------------------------------------------------------
-- T5: two rows closer than the window, written directly (bypassing the
-- guard, as a regressed client effectively would) — the probe sees them.
-- Direct INSERT because the whole point is to simulate the guard failing.
-- ------------------------------------------------------------
INSERT INTO gene_invocation_log (gene_id, caller_agent_id, invoked_at)
VALUES ('d2222222-2222-4222-8222-222222222222', 'caller-a', now() - INTERVAL '2 seconds'),
       ('d2222222-2222-4222-8222-222222222222', 'caller-a', now() - INTERVAL '1 second');

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'caller-a')::INT,
  1,
  'a pair inside the window is reported once, not twice'
);

-- ------------------------------------------------------------
-- T6: the partition is per (gene, caller), not global. Two different
-- callers hitting the same gene at the same moment is ordinary traffic,
-- and a probe that flagged it would fire on every popular gene.
-- ------------------------------------------------------------
INSERT INTO gene_invocation_log (gene_id, caller_agent_id, invoked_at)
VALUES ('d3333333-3333-4333-8333-333333333333', 'caller-b', now() - INTERVAL '2 seconds'),
       ('d3333333-3333-4333-8333-333333333333', 'caller-c', now() - INTERVAL '2 seconds');

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE gene_id = 'd3333333-3333-4333-8333-333333333333')::INT,
  0,
  'two different callers at the same instant are not a duplicate'
);

DELETE FROM gene_invocation_log
 WHERE gene_id IN ('d2222222-2222-4222-8222-222222222222',
                   'd3333333-3333-4333-8333-333333333333');

-- ------------------------------------------------------------
-- T7-T8: guard and probe agree on the window, checked through behaviour.
--
-- Going through log_gene_invocation() means the guard decides what lands,
-- and the probe then reads it. Both directions must come out clean: a
-- duplicate is collapsed by the guard (so nothing to find), and a genuine
-- repeat outside the window is kept (and is not mistaken for a duplicate).
-- ------------------------------------------------------------
SELECT log_gene_invocation('d2222222-2222-4222-8222-222222222222', 'caller-guarded');
SELECT log_gene_invocation('d2222222-2222-4222-8222-222222222222', 'caller-guarded');

SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'caller-guarded')::INT,
  1,
  'guard collapses the immediate repeat'
);

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'caller-guarded')::INT,
  0,
  'probe finds nothing behind a working guard'
);

-- A genuine repeat, older than the window: the guard lets it through and the
-- probe must not call it a duplicate. This is the assertion that breaks if
-- the probe ever uses a wider threshold than the guard.
INSERT INTO gene_invocation_log (gene_id, caller_agent_id, invoked_at)
VALUES ('d2222222-2222-4222-8222-222222222222', 'caller-spaced', now() - INTERVAL '30 seconds');
SELECT log_gene_invocation('d2222222-2222-4222-8222-222222222222', 'caller-spaced');

SELECT is(
  (SELECT count(*) FROM gene_invocation_log
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'caller-spaced')::INT,
  2,
  'guard keeps a genuine repeat outside the window'
);

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE gene_id = 'd2222222-2222-4222-8222-222222222222' AND caller_agent_id = 'caller-spaced')::INT,
  0,
  'probe does not call a genuine repeat a duplicate'
);

-- ------------------------------------------------------------
-- T10-T11: pre-guard history is labelled, not counted and not erased.
-- ------------------------------------------------------------
INSERT INTO gene_invocation_log (gene_id, caller_agent_id, invoked_at)
VALUES ('d3333333-3333-4333-8333-333333333333', 'caller-legacy',
        invocation_dedup_guard_since() - INTERVAL '2 hours'),
       ('d3333333-3333-4333-8333-333333333333', 'caller-legacy',
        invocation_dedup_guard_since() - INTERVAL '2 hours' + INTERVAL '1 second');

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE caller_agent_id = 'caller-legacy' AND after_guard = false)::INT,
  1,
  'a pre-guard pair is still visible, marked as history'
);

SELECT is(
  (SELECT count(*) FROM gene_invocation_duplicate_probe
    WHERE caller_agent_id = 'caller-legacy' AND after_guard)::INT,
  0,
  'a pre-guard pair does not count against the guard that came later'
);

SELECT * FROM finish();
ROLLBACK;
