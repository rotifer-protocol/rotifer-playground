-- ============================================================
-- ADR-323 D3 — who is behind a publishing identity, as a readable fact
--
-- `profiles` carries a username, an avatar and a github_id. Nothing on it can
-- say who operates the account, how many people that is, or what happened to
-- a predecessor identity. So `rotifer-protocol` reads as an organisation and
-- there is nowhere to record that it is one person — which is exactly the gap
-- the roundtable made a hard condition of keeping the name.
--
-- The alternative on the table was renaming 59 public genes to a personal
-- handle. That was voted down 5:0 because it communicates "ownership changed",
-- not "one person is behind this"; the disclosure has to be written where
-- someone actually reads it rather than inferred from an author line.
--
-- Nullable, no default, no backfill: a profile with nothing to disclose should
-- render nothing, not an empty string that the UI has to special-case.
--
-- Additive per ADR-295.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS steward_note TEXT;

COMMENT ON COLUMN profiles.steward_note IS
  'ADR-323 D3: who operates this publishing identity, in plain language — how many people hold it, and what became of any identity it replaced. Rendered on the developer page. Null means there is nothing to disclose, which is different from an empty disclosure.';

-- Length bound rather than free rein: this is a disclosure, not a profile bio,
-- and an unbounded public text column on an anon-readable table is an invitation.
DO $$ BEGIN
  ALTER TABLE profiles ADD CONSTRAINT chk_steward_note_length
    CHECK (steward_note IS NULL OR char_length(steward_note) <= 500);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
