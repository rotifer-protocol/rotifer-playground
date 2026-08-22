-- ============================================================
-- ADR-323 D3, continued — the disclosure in a language the reader reads
--
-- `steward_note` is one string in one language. The Chinese developer page
-- rendered a Chinese heading over an English paragraph, which reads as
-- unfinished; rotifer-dev closed that by keeping the translation in the site
-- and labelling it as a translation (rotifer-dev#148).
--
-- Keeping it there has one defect this column exists to fix: the site is not
-- where the record lives. A reader who queries the field gets English only,
-- and a translation the API cannot serve is site copy rather than part of the
-- disclosure.
--
-- Moving it here is only an improvement if the guard comes with it. A bare
-- `steward_note_zh` column would be a step backwards: edit `steward_note` and
-- the Chinese silently keeps describing the previous disclosure, with nothing
-- in the schema able to notice. So each translation stores the exact source it
-- was translated from, and readers compare before trusting it. The pin is the
-- feature; the translation is just text.
--
--   {
--     "zh": {
--       "text":   "<the disclosure, translated>",
--       "source": "<steward_note exactly as it read when this was written>"
--     }
--   }
--
-- One JSONB column rather than a column per language, because ADR-295 is
-- additive-only: a `_zh` column commits this table to a new permanent column
-- for every language the site ever adds, and none of them can be taken back.
--
-- Additive per ADR-295. Idempotent — production applies these by hand.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS steward_note_i18n JSONB;

COMMENT ON COLUMN profiles.steward_note_i18n IS
  'ADR-323 D3: translations of steward_note, keyed by BCP-47 locale. Each value is {"text": <translation>, "source": <steward_note as it read when translated>}. Readers must compare source against the current steward_note and fall back to steward_note when they differ — a translation of a disclosure that has since been edited is worse than no translation. Null means no translations exist, which is different from an empty object.';

-- CHECK cannot contain a subquery, and validating a JSON document needs one.
-- The predicate therefore lives in a function the constraint calls.
--
-- Bounds, not free rein, for the same reason the parent column has them: this
-- is an anon-readable column on a public table, and an unbounded JSON document
-- there is storage waiting to be used as storage. The byte bound covers the
-- whole document rather than the two fields, so keys nobody has thought of yet
-- are allowed but cannot be used to smuggle a payload past the per-field caps.
--
-- `IS DISTINCT FROM`, not `<>`, on every typeof. A missing key makes
-- `entry -> 'source'` SQL NULL, `jsonb_typeof` of that NULL, and `NULL <>
-- 'string'` is NULL rather than true — so a plain `<>` chain silently accepts
-- exactly the document this column exists to reject: a translation with no pin.
-- Verified by making it fail: with `<>` the unpinned entry is accepted.
CREATE OR REPLACE FUNCTION steward_note_i18n_is_valid(doc jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = 'public'
AS $$
  SELECT doc IS NULL OR (
    jsonb_typeof(doc) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(doc)) BETWEEN 1 AND 8
    AND octet_length(doc::text) <= 32768
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_each(doc) AS e(locale, entry)
       WHERE locale !~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
          OR jsonb_typeof(entry) IS DISTINCT FROM 'object'
          OR jsonb_typeof(entry -> 'text') IS DISTINCT FROM 'string'
          OR jsonb_typeof(entry -> 'source') IS DISTINCT FROM 'string'
          OR char_length(entry ->> 'text') NOT BETWEEN 1 AND 500
          OR char_length(entry ->> 'source') NOT BETWEEN 1 AND 500
    )
  );
$$;

COMMENT ON FUNCTION steward_note_i18n_is_valid(jsonb) IS
  'Shape and bounds for profiles.steward_note_i18n. Every entry must carry both a translation and the source it was translated from: a translation with no pin cannot be checked for staleness, so the schema does not accept one.';

DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT chk_steward_note_i18n_shape
    CHECK (steward_note_i18n_is_valid(steward_note_i18n));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
