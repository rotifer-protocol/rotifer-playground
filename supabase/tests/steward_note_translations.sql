-- ============================================================
-- pgTAP tests for translated identity disclosures (ADR-323 D3)
-- File: supabase/tests/steward_note_translations.sql
-- ============================================================
--
-- Migration 20260822101500. The column's job is not to hold a translation —
-- any text column does that. Its job is to make an *unpinned* translation
-- unrepresentable, so a disclosure edited in `steward_note` cannot leave a
-- stale translation behind it still claiming to say the same thing.
--
-- So the rejections are the subject here, and T4 is the one that earns the
-- file. The first cut of the constraint accepted an entry with no `source`:
-- a missing key makes `entry -> 'source'` SQL NULL, `jsonb_typeof` of that
-- NULL, and `NULL <> 'string'` is NULL rather than true, so the predicate
-- never fired. Every other case in this file passed while the one case the
-- column exists for slipped through. It was caught by running the DDL against
-- a real Postgres rather than reading it.
--
-- Run inside supabase test container:
--   supabase test db

BEGIN;

SELECT plan(20);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('d3333333-3333-4333-8333-333333333333', 'i18n-a@example.com', '{"user_name": "i18n_a"}'::jsonb);

-- ---------- the column ----------

SELECT has_column('public', 'profiles', 'steward_note_i18n',
  'T1: profiles can record translations of the disclosure');
SELECT col_type_is('public', 'profiles', 'steward_note_i18n', 'jsonb',
  'T2: translations are stored as jsonb, not as text for readers to parse');
SELECT is((SELECT steward_note_i18n FROM profiles WHERE id = 'd3333333-3333-4333-8333-333333333333'),
  NULL, 'T3: a profile with no translations stores null');

-- ---------- what a translation must carry ----------

SELECT lives_ok(
  $$ UPDATE profiles SET steward_note_i18n =
       '{"zh": {"text": "由一个人运营。", "source": "Operated by one person."}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  'T4: a translation carrying its source is accepted');
SELECT is(
  (SELECT steward_note_i18n -> 'zh' ->> 'source' FROM profiles WHERE id = 'd3333333-3333-4333-8333-333333333333'),
  'Operated by one person.',
  'T5: the pin survives the write, which is the only reason to store it');

-- The four shapes of "no usable pin". T6 is the regression test: it passed
-- against the first constraint, which is how the hole got found.
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh": {"text": "由一个人运营。"}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T6: a translation with no source is rejected');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh": {"text": "x", "source": null}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T7: a JSON null source is rejected — it pins nothing');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh": {"text": "x", "source": 42}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T8: a non-string source is rejected');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh": {"source": "Operated by one person."}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T9: a pin with no translation is rejected');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh": "由一个人运营。"}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T10: a bare string in place of an entry is rejected');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh": {"text": "", "source": "x"}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T11: an empty translation is rejected, not rendered as a blank paragraph');

-- ---------- bounds ----------

SELECT lives_ok(
  format($$ UPDATE profiles SET steward_note_i18n =
       jsonb_build_object('zh', jsonb_build_object('text', %L, 'source', 'x'))
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$, repeat('y', 500)),
  'T12: 500 characters exactly is accepted');
SELECT throws_ok(
  format($$ UPDATE profiles SET steward_note_i18n =
       jsonb_build_object('zh', jsonb_build_object('text', %L, 'source', 'x'))
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$, repeat('y', 501)),
  '23514', NULL, 'T13: a translation over 500 characters is rejected');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n =
       (SELECT jsonb_object_agg('l' || chr(96 + i), jsonb_build_object('text', 'x', 'source', 'y'))
          FROM generate_series(1, 9) i)
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T14: more than 8 locales is rejected');

-- Keys nobody has thought of yet are tolerated, so that adding a field later
-- is not constraint surgery — but the document as a whole is bounded, so the
-- tolerance cannot be used to smuggle a payload past the per-field caps.
SELECT lives_ok(
  $$ UPDATE profiles SET steward_note_i18n =
       '{"zh": {"text": "x", "source": "y", "translated_by": "z"}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  'T15: an unrecognised key inside an entry is tolerated');
SELECT throws_ok(
  format($$ UPDATE profiles SET steward_note_i18n =
       jsonb_build_object('zh', jsonb_build_object('text', 'x', 'source', 'y', 'junk', %L))
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$, repeat('z', 40000)),
  '23514', NULL, 'T16: a document over 32KB is rejected whatever shape it takes');

-- ---------- keys are locales ----------

SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"Chinese": {"text": "x", "source": "y"}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T17: a key that is not a locale tag is rejected');
SELECT lives_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{"zh-Hant": {"text": "x", "source": "y"}}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  'T18: a BCP-47 tag with a script subtag is accepted');

-- ---------- the resting state is null, not an empty document ----------

SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '{}'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T19: an empty object is rejected — no translations is null');
SELECT throws_ok(
  $$ UPDATE profiles SET steward_note_i18n = '[]'::jsonb
      WHERE id = 'd3333333-3333-4333-8333-333333333333' $$,
  '23514', NULL, 'T20: a document that is not an object is rejected');

SELECT * FROM finish();
ROLLBACK;
