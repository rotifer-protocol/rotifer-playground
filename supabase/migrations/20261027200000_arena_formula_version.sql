-- ============================================================
-- arena_entries.formula_version: which F(g) formula produced the score
-- (ADR-345 D5 option A, T-107)
-- ============================================================
--
-- The same inputs have produced three different F(g) scales in two months:
-- additive (version 1), multiplicative in (0, 2·ln 2] (version 2, ADR-318 D2,
-- CLI 0.25.0) and multiplicative normalized to [0, 1] (version 3, ADR-345).
-- Nothing in arena_entries said which one a row used, so telling them apart
-- meant guessing from dates — and old and new CLIs upload side by side.
--
-- Additive only (ADR-295): a nullable column, NULL on every row written
-- before it existed and on every row an older CLI writes. rotifer-core numbers
-- its versions the same way (fitness::FORMULA_VERSION).
--
-- The value is the client's own label, like evaluation_method: estimated rows
-- do not rank, and binding_runtime rows are written by the server. So the
-- check only refuses what cannot be a version (0, negative). It does not list
-- the known versions: a CLI shipping version 4 would otherwise have every
-- upload refused until a migration caught up.
--
-- guard_arena_entry_client_write (20261021200000, 20261027100000) does not
-- look at this column, and needs no change: it guards the columns it names.
-- What a client may send is the GRANT list from 20261021200000, so the column
-- is added to it here — INSERT, and UPDATE because the CLI's upsert needs
-- UPDATE on every column it sends.
--
-- Order on production: after 20261027100000 (T-100). 20260901050000 stays
-- unapplied, as before; this migration does not depend on it.

ALTER TABLE arena_entries ADD COLUMN IF NOT EXISTS formula_version smallint;

ALTER TABLE arena_entries
  ADD CONSTRAINT chk_arena_formula_version CHECK (formula_version IS NULL OR formula_version >= 1);

COMMENT ON COLUMN arena_entries.formula_version IS
  'Which F(g) formula produced fitness_value, as the submitting client reports it: 1 additive, 2 multiplicative in (0, 2·ln 2] (ADR-318 D2), 3 multiplicative normalized to [0, 1] (ADR-345). NULL on rows written before 2026-10-27 and by CLIs that do not send it.';

GRANT INSERT (formula_version) ON arena_entries TO authenticated;
GRANT UPDATE (formula_version) ON arena_entries TO authenticated;
