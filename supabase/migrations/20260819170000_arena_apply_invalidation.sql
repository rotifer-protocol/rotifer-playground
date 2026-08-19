-- ============================================================
-- ADR-319 D2, plan 2.5 write layer: apply the invalidation criteria
--
-- The criteria have been readable since #214 (`rotifer arena audit`, and
-- src/arena/invalidation-criteria.ts). This is the half that writes them down.
--
-- Nothing is deleted. A disqualified row keeps every number it had and gains
-- two fields — when, and under which criterion — and drops out of the rankable
-- set via the partial index from 20260818150000. History stays checkable;
-- §9.7.1 would mean very little if the evidence for a removal were itself
-- removed.
--
-- Two of the three criteria are pure SQL. The third reads the published
-- binary, which SQL cannot do, so the scan result is stored as evidence in
-- gene_artifact_scan and the SQL criterion reads that. The scan is
-- reproducible by anyone: the `gene-wasm` bucket serves without credentials,
-- the markers are the same two the runtime refuses to execute
-- (crates/rotifer-core/src/sandbox/wasmtime_sandbox.rs ASYNC_EXPRESS_MARKERS),
-- and every row records the SHA-256 of the exact bytes that were scanned. 33
-- of the 63 rows below could be checked against genes.wasm_hash at insert
-- time; all 33 matched, and the other 30 have no stored hash to compare.
--
-- Self-correcting, not one-shot. The job clears an invalidation it previously
-- set once the criteria stop firing for that row — which is what makes a
-- criteria change safe to deploy (#220 narrowed no-published-artifact to
-- Native and nine Hybrid rows stopped qualifying; had this run first, those
-- nine would have been released on the next run rather than left stranded).
-- Invalidations carrying any other reason are never touched: a removal this
-- job did not make is not a removal this job may undo.
--
-- Republishing is the way back, and it needs no special handling: a version is
-- immutable, so a fixed gene is published under a new version, which is a new
-- gene id and a new Arena row that no criterion fires on. The old row stays
-- disqualified, correctly — its artifact really did behave that way.
--
-- Additive per ADR-295 on the schema side (one table, two functions, one
-- view). The UPDATE is the backfill step, scoped to rows the criteria decide.
-- ============================================================

-- ── The artifact scan, as evidence ──────────────────────────

CREATE TABLE IF NOT EXISTS gene_artifact_scan (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gene_id     UUID NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
  wasm_sha256 TEXT NOT NULL,
  marker      TEXT NOT NULL,
  occurrences INTEGER NOT NULL,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_artifact_scan_sha CHECK (wasm_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_artifact_scan_count CHECK (occurrences > 0),
  CONSTRAINT uq_artifact_scan UNIQUE (gene_id, wasm_sha256, marker)
);

COMMENT ON TABLE gene_artifact_scan IS
  'Findings from scanning published WASM for the async-express markers the runtime refuses to execute (ADR-319 D2 / plan 2.5). Evidence, not verdict: pinned to the SHA-256 of the exact bytes scanned, and reproducible by anyone from the public gene-wasm bucket.';

ALTER TABLE gene_artifact_scan ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'gene_artifact_scan' AND policyname = 'Artifact scans are publicly readable') THEN
    CREATE POLICY "Artifact scans are publicly readable" ON gene_artifact_scan FOR SELECT USING (true);
  END IF;
END $$;

-- No INSERT/UPDATE/DELETE policy, and DML revoked: a client that could plant a
-- finding could disqualify anyone's gene.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON gene_artifact_scan FROM anon, authenticated;

-- Seeded from a scan of every published artifact on 2026-08-19. Guarded by an
-- EXISTS rather than inserted blind: on a fresh database (local reset, CI
-- migration replay) none of these genes exist and the seed is correctly a
-- no-op, while on production all 63 resolve.
INSERT INTO gene_artifact_scan (gene_id, wasm_sha256, marker, occurrences)
SELECT v.gene_id, v.wasm_sha256, v.marker, v.occurrences
  FROM (VALUES
  ('2a9813e3-05ab-4958-888f-ea4df46afa13'::UUID, 'd6c13fa48dfa06660a691b2292c1c4c6d048c08af889b1252273b9762eb8022e'::TEXT, 'async function express'::TEXT, 4::INTEGER),
  ('f6f7b7b6-9d59-4977-862d-fad378e1c422', '29a3b6701abd60e7463573dd468e28a10c18b456a8728fcfb19993cd48744783', 'async function express', 4),
  ('2d9715bb-2939-40e1-bd07-9d9b03d2f300', '7381ad5a8644329aed1356adb05b55970ff7dc0d40e507092c592c0c2242928f', 'async function express', 4),
  ('01679301-8cf3-4209-9525-39b1641537b8', '14138b86d9c89b2aaec86e02e8ac70285494d90418d2153908c63a3b4d48bb49', 'async function express', 3),
  ('22334201-f9b4-45d7-9d54-921c43655aa7', 'd61eaded9d750801cb2d3fa8def6a1d8cd44d64b7f8190109973c34e909f7444', 'async function express', 4),
  ('a4541580-07a3-4468-b7c8-a4f245134512', 'ddcc06e3965301a27ed84a2970f99e1340c313a02c3f7f1d7ada845bf97d76ea', 'async function express', 4),
  ('12e0cd8a-594f-42c7-a075-d39270d3674a', '5ddc49bb51a9c24333c1081421c6808bfb334c220c37a6ee6713503106b57744', 'async function express', 4),
  ('8d130f21-2cf8-4349-b500-0a979dd9e9cf', 'd62e47bfcd2a90c1ca5c67b5a743ab61d5e7cdd0e683a329f557a6d0931241a1', 'async function express', 3),
  ('7473b232-40b6-4425-ab34-cc95979c134c', '05ec4e7223867b970b69c499005cdba6bd2c0fb289dd08a924a5168b26f4d321', 'async function express', 3),
  ('35e47cde-54fb-41fc-9f8e-7e9a119879d3', '2620088702548aa08c1568b3866acfe57631e6bf27b6e18f73ca33b7cab5d802', 'async function express', 3),
  ('6c31a9f0-dad7-4a21-9a1a-f65d1943e2b9', '4827cba486e311ca4041ab212dcfe73d2d3152fedf3bb5712e0d6c623bcc7035', 'async function express', 3),
  ('f2ec71e8-f025-4773-b415-1f95423923e6', '3f31fe0384400d1b2496ed5c5f106158243e96479c74ce9ec43bfb4b9393a10b', 'async function express', 4),
  ('fa48c2bc-094b-4b24-9039-2c22c23acc65', 'dbf02f17e3ddaeb67a1e21c6c4e06f1339535cb18c2806ef827ef868c36dd595', 'async function express', 3),
  ('8fd8cbc7-e7c0-451f-b210-75893ac2319f', 'ce7d342d4531b58c89b363b7ee5e9400f4b3183101b54f3631f0d1cf109c203a', 'async function express', 3),
  ('34d5df87-a786-43eb-894a-ab97d58b25ef', 'aa112229808d0e0068bc17c243576381199cff9f347c96cc6143378698fd8d13', 'async function express', 3),
  ('d10bff7a-277d-478d-84e6-e3b014dc0862', '5481ba1a0e17446d23beaf6b769c7480883bc56e7271b15999fe348f01564ddf', 'async function express', 4),
  ('35dff37e-db1f-4f94-8660-7ff4daa44202', '15b8e8b0857590b96f050eac6617e4f3fcf0f8bf6cf0670311bcc2b33f03f46f', 'async function express', 3),
  ('281e5edb-7ec4-4ea9-a806-c7fe8445bf48', 'aaf728b5b829e1bfba35c145b917ab305d5a7ccd900321852427f1f46a6e9804', 'async function express', 3),
  ('d4220d52-47fd-46e8-8814-ed48e85a2c58', 'd62e47bfcd2a90c1ca5c67b5a743ab61d5e7cdd0e683a329f557a6d0931241a1', 'async function express', 3),
  ('9f3a342a-7f47-475e-8b00-e66d0f9095c3', '008d440bec0380f11644f1e76bb682c8ca83cc7153f8a311e0f7a0869525c1aa', 'async function express', 4),
  ('bdec0591-d1ce-4aa4-aabe-22225d785f3e', '305121c22f61596a9455ab69fb3c777f3fefaa9c3fe288df0887782196940061', 'async function express', 3),
  ('1ace9dba-e0e7-41e5-b0ef-c292dd473c99', 'd9fe9c88795ca2d1de4feddb0e3eedc1a15bd4fb266f2c6bdd4d9afdcc7d9bf6', 'async function express', 3),
  ('a9114688-316c-4588-938d-681a81a1dd92', '6edfc939b50972f582614a6dd581c62ac5a3ce950debefb9e7ab28b0443e8daa', 'async function express', 3),
  ('1ae335d9-1382-4ec5-be40-e4205d4d4266', '05ec4e7223867b970b69c499005cdba6bd2c0fb289dd08a924a5168b26f4d321', 'async function express', 3),
  ('11322090-ebad-4baf-b42b-c320da8d1f4f', '008d440bec0380f11644f1e76bb682c8ca83cc7153f8a311e0f7a0869525c1aa', 'async function express', 4),
  ('04c541be-839a-4be1-909d-b7bca7a41ca0', 'e2f1e4309b5b802747eb8d792090a55b5c2c9e658e41c853f528e0daefeb7776', 'async function express', 4),
  ('18dc5e5a-507d-4757-ae95-63908949e653', '0f26876930e58be5a4820f794dedc98497756eb78109814c51cea083524f2b28', 'async function express', 3),
  ('12e6954c-bbae-4381-9eb8-728e2eaa73a8', 'a6b5a526481e20b6f7510dea085cdbdfc7ad75b7084146db01163cf8c614b446', 'async function express', 3),
  ('5ad8fa7c-6634-4600-bed9-2c90582329c5', 'fe38ebbf93b2b71b75d9dbebe4784e59ebf93d0c5c317a125bcac829fd244ebd', 'async function express', 3),
  ('402b071e-7c31-4248-9390-7d8bcf24725f', '03907c4fc5db65f7f8705941be1f4f87a9e1acfcc4dc4089bedaed42b24d2a9e', 'async function express', 3),
  ('ffb0e7e3-34c1-4936-a731-085d1674fefc', 'ac8e11f02e4d5327dcb6b0326664e4b17015dc4d043706db3d948f9f181b7bd8', 'async function express', 4),
  ('cd6dbb7e-93f7-4fcd-886d-36c273b0cec8', '00abdd4652a064735d2272a8c340fef68d666581d2817018ac473da6deba438f', 'async function express', 4),
  ('dd5d61bb-d209-43ef-901b-071e6f169420', '0a65ffbb5e5d4bf894391b0a4ce25bc72c53a9397905d5804df84a5756d9375a', 'async function express', 4),
  ('c6d934f7-c9c9-4123-b686-a1ec512472a6', 'a466c7213948e3ea58adf407bd93546f900eb8258b369ce947cf10bb76fbf425', 'async function express', 3),
  ('250243be-4f02-4a29-8d8a-fe8bc3609c76', '25126180777a719ef9b46b41179fc2e03da2a16587d3f9d36206cef7e763c412', 'async function express', 4),
  ('2d3259d0-c696-49bb-9d01-497e295b9397', '11865e768df47a0388f40de6eca2c687bca67f7da516e53f93c97da1fc4475b3', 'async function express', 3),
  ('4731c038-a239-4336-b7f9-a59af960295f', '0650f58b6972b5693fb04271d5ca260abfe33adff9f6aadc6d2acc44d4a9bd9e', 'async function express', 3),
  ('f5c93229-3f8e-4840-9a89-224cb293a726', 'fe38ebbf93b2b71b75d9dbebe4784e59ebf93d0c5c317a125bcac829fd244ebd', 'async function express', 3),
  ('bb882ec4-73b4-482c-b37c-720379ff045a', '05ec4e7223867b970b69c499005cdba6bd2c0fb289dd08a924a5168b26f4d321', 'async function express', 3),
  ('30e35b9b-a377-4a2b-a7eb-fce16f379941', 'a84ab00251a55613538e665efb41596ad5c0d50ffbb5c7901fe2c4bd82383ec7', 'async function express', 3),
  ('6b323386-f64c-421d-bc8c-24ac627db4ce', '16015dc18b788a9c7580dbe7155ba3bb4ee03dc15271468254d919ae17924508', 'async function express', 3),
  ('aa29712d-83a9-46b9-9bda-95acb18c58e8', '023c9f2a6819a5005376ccce4bdd4ad4433b04677ba1ff315878ca3c3ec9ee66', 'async function express', 3),
  ('cc5f9156-159c-4ab7-993a-cd5fe396d1ad', 'a466c7213948e3ea58adf407bd93546f900eb8258b369ce947cf10bb76fbf425', 'async function express', 3),
  ('59ce93bc-f246-4d2f-b9da-48422f4d06b1', '35c9cb3f4a6ee4bb22f23b221945bb308895e7c20bd12028dfab294be090a87c', 'async function express', 3),
  ('3b28374c-6e86-4b8c-a3ef-e0b478d40a5b', '839caeaeca4d7e7c89add21467fa4e51d3fd133688acf5d2d27c639f3aab4b51', 'async function express', 4),
  ('a98c77d4-687c-47ae-8393-920e90c12cb1', '61722347dccd2a3407d22ad57a373cef6bf41d1eff7ecfcaf2b77bbb9b132167', 'async function express', 4),
  ('23f99ba1-ddaf-4966-beb2-84eab9eef8e4', '7121d0664faead7db1a3addb7fc32996b01f83abfe712b8ac2f9f355080779a2', 'async function express', 3),
  ('ac3404a8-3209-4091-bb4e-b07ef28fc1da', '6edfc939b50972f582614a6dd581c62ac5a3ce950debefb9e7ab28b0443e8daa', 'async function express', 3),
  ('bc3d9db5-2a59-4768-a666-917371ca6fe7', 'a466c7213948e3ea58adf407bd93546f900eb8258b369ce947cf10bb76fbf425', 'async function express', 3),
  ('0dcc5197-ed07-49bf-bcec-57ce37272f87', '40460667be448711ab44d18ff55dfc6ba3d7ae0e09f348297885eba358878f40', 'async function express', 3),
  ('f0ed3cad-dd1d-4485-8ea6-bb74972e5f0e', '98920e0cfc8c97cd29c4c9c1731408e91645ed042fc2191ab82a6d3b5e996262', 'async function express', 3),
  ('cd3595fc-a317-4ab0-8ac4-f15a093024fc', '6edfc939b50972f582614a6dd581c62ac5a3ce950debefb9e7ab28b0443e8daa', 'async function express', 3),
  ('bf917833-f1c4-4b41-a2f0-b141224c7cc5', '271fc9152134ca79ff4724b3209a3a5dda468bd593a46493678eeefd9c649bc8', 'async function express', 4),
  ('c40114bb-5919-4a8b-b84d-00ca09cbf6a8', '41731571e5fb89e2321a285a68f05333336faa72708c79bf50cdb334c84251df', 'async function express', 4),
  ('f3ed35c9-cfe6-4319-908c-47419f3ae631', 'b362aa0b5b4fecb19a13661796b68af105854c72ab8722e1416c2db910be2cd5', 'async function express', 3),
  ('3bed2b88-1e77-4f88-a1a2-df6ded8a3b48', '88a62f9fab48e31eb39d5bf7510aefcd6f0e4e00616c3dbdc424dd2a779c02eb', 'async function express', 3),
  ('d8d9c501-4b29-4d22-acb6-f432b0b26ac8', 'a466c7213948e3ea58adf407bd93546f900eb8258b369ce947cf10bb76fbf425', 'async function express', 3),
  ('5d3148b0-6546-4e72-91b2-0fcd2de0d9fe', '1f706fbd26e6599c2b32b60eed8bbb9958cd5c9e398211b990060a41c5a48d2b', 'async function express', 4),
  ('df8f5f8c-c51c-46a7-a28c-22813a46f739', '1f706fbd26e6599c2b32b60eed8bbb9958cd5c9e398211b990060a41c5a48d2b', 'async function express', 4),
  ('5dd6f44d-c656-49de-9f3c-6e0d8b23e311', '3994ed7d8e53b46cbdbebf6b936604501a04cca3c188d87ebd770a954afb42b9', 'async function express', 4),
  ('a29c1488-8591-40e9-bc9e-5edbafdd66b3', 'da549c9417f824a6fcb6ebefbc0942ec1e06bced76af139dd5ea1c19723450d9', 'async function express', 4),
  ('4e631144-8ec1-4580-9f39-15b48768d37c', '1741749e6dea1bd7b770a7de5baf47f9c70210003a8df05fc21a4b8bef24df14', 'async function express', 4),
  ('6ee14b11-9b0e-4527-b147-b4d33a0ec7b2', 'a466c7213948e3ea58adf407bd93546f900eb8258b369ce947cf10bb76fbf425', 'async function express', 3)
  ) AS v(gene_id, wasm_sha256, marker, occurrences)
 WHERE EXISTS (SELECT 1 FROM genes g WHERE g.id = v.gene_id)
ON CONFLICT (gene_id, wasm_sha256, marker) DO NOTHING;

-- ── The verdict, in SQL, mirroring src/arena/invalidation-criteria.ts ──

/**
 * Which criterion disqualifies this Arena row, or NULL.
 *
 * Order matters and matches the CLI: most fundamental first. Asking whether an
 * artifact carries a defect is meaningless for a row that has no artifact, or
 * that was never a real gene.
 */
CREATE OR REPLACE FUNCTION arena_invalidation_verdict(p_gene_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT CASE
    -- test-data: submitted under the 'test' domain
    WHEN lower(btrim(coalesce(a.domain, ''))) = 'test'
      THEN 'test-data'
    -- no-published-artifact: Native promises an executable artifact. Only
    -- Native — the shipping Hybrid path runs under Node.js and publishes none
    -- (see WASM_BEARING_FIDELITIES in src/arena/invalidation-criteria.ts).
    -- An unreadable gene is one its author unpublished, not a defect.
    WHEN g.id IS NOT NULL AND g.fidelity = 'Native' AND coalesce(g.wasm_size, 0) = 0
      THEN 'no-published-artifact'
    -- async-express-artifact: the published binary carries a marker the
    -- runtime refuses to run, so the score measured the empty object it
    -- returns, not the gene.
    WHEN EXISTS (SELECT 1 FROM gene_artifact_scan s WHERE s.gene_id = a.gene_id)
      THEN 'async-express-artifact'
    ELSE NULL
  END
  FROM arena_entries a
  LEFT JOIN genes g ON g.id = a.gene_id
  WHERE a.gene_id = p_gene_id;
$$;

COMMENT ON FUNCTION arena_invalidation_verdict(UUID) IS
  'ADR-319 D2 / plan 2.5: the criterion that disqualifies an Arena row, or NULL. Mirrors src/arena/invalidation-criteria.ts; `rotifer arena audit` recomputes the same verdicts from public data.';

/** The reasons this job owns. It never clears an invalidation it did not set. */
CREATE OR REPLACE FUNCTION arena_invalidation_reasons()
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = 'public'
AS $$ SELECT ARRAY['test-data', 'no-published-artifact', 'async-express-artifact'] $$;

-- ── Apply ───────────────────────────────────────────────────

/**
 * Write the verdicts. Idempotent and self-correcting.
 *
 * Sets invalidation where a criterion fires and none is recorded; clears it
 * where no criterion fires and the recorded reason is one of ours; leaves
 * everything else alone. Returns what it changed, so a run is auditable
 * rather than silent.
 */
CREATE OR REPLACE FUNCTION apply_arena_invalidation()
RETURNS TABLE (invalidated INTEGER, released INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_inv INTEGER;
  v_rel INTEGER;
BEGIN
  WITH v AS (
    SELECT a.gene_id, arena_invalidation_verdict(a.gene_id) AS reason
      FROM arena_entries a
  ),
  ins AS (
    UPDATE arena_entries a
       SET invalidated_at = now(), invalidation_reason = v.reason
      FROM v
     WHERE v.gene_id = a.gene_id
       AND v.reason IS NOT NULL
       AND a.invalidated_at IS NULL
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inv FROM ins;

  WITH v AS (
    SELECT a.gene_id, arena_invalidation_verdict(a.gene_id) AS reason
      FROM arena_entries a
  ),
  del AS (
    UPDATE arena_entries a
       SET invalidated_at = NULL, invalidation_reason = NULL
      FROM v
     WHERE v.gene_id = a.gene_id
       AND v.reason IS NULL
       AND a.invalidated_at IS NOT NULL
       AND a.invalidation_reason = ANY (arena_invalidation_reasons())
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_rel FROM del;

  RETURN QUERY SELECT v_inv, v_rel;
END;
$$;

COMMENT ON FUNCTION apply_arena_invalidation() IS
  'ADR-319 D2 / plan 2.5: applies arena_invalidation_verdict to every row. Idempotent; clears only invalidations whose reason this job owns (arena_invalidation_reasons).';

-- ── The drift probe ─────────────────────────────────────────

CREATE OR REPLACE VIEW arena_invalidation_probe
WITH (security_invoker = true) AS
SELECT
  a.gene_id,
  a.invalidation_reason AS recorded_reason,
  arena_invalidation_verdict(a.gene_id) AS computed_reason,
  a.invalidated_at,
  a.domain,
  g.name AS gene_name,
  g.fidelity,
  g.wasm_size
FROM arena_entries a
LEFT JOIN genes g ON g.id = a.gene_id;

COMMENT ON VIEW arena_invalidation_probe IS
  'Every Arena row with the criterion that disqualifies it (computed) next to what the ledger records. A recorded reason with no computed one is an invalidation no criterion reproduces — a stale criterion, or a hand edit (ADR-319 D6).';

GRANT SELECT ON arena_invalidation_probe TO anon, authenticated;

-- ── Run it ──────────────────────────────────────────────────

SELECT * FROM apply_arena_invalidation();
