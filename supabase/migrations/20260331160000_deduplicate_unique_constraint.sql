-- Remove duplicate UNIQUE constraint on genes(owner_id, name, previous_version_id).
-- Two migrations independently created constraints on the same columns:
--   20260330130000: uq_version_chain_linear
--   20260331120000: uq_owner_name_prev_version
-- Keep uq_version_chain_linear (created first), drop the duplicate.

ALTER TABLE genes DROP CONSTRAINT IF EXISTS uq_owner_name_prev_version;
