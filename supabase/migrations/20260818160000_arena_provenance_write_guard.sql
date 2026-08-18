-- ============================================================
-- ADR-319 D2 / 专项阶段 2.2: the server decides what it can decide
--
-- 2.1 gave arena_entries an evaluation_method column. This adds the guard,
-- and the guard is narrower than the ADR's phrasing suggests — deliberately,
-- because the alternative is a field that looks trustworthy and is not.
--
-- Both write paths (CLI src/cloud/client.ts, MCP src/cloud.ts) POST straight
-- to /arena_entries through PostgREST. There is no RPC in between. So a
-- client sends whatever columns it likes, and "clients must not choose
-- binding_runtime" cannot be satisfied by asking clients nicely.
--
-- What the server CAN verify, and does here:
--
--   binding_runtime  identity. Only the binding writes it. A request
--                    carrying an `authenticated` or `anon` JWT is a client
--                    request by definition, and is refused.
--   evaluator        identity. Stamped from the authenticated principal,
--                    overwriting whatever the client sent. A self-reported
--                    "who measured this" is worth nothing.
--
-- What the server CANNOT verify, and this migration does not pretend to:
--
--   sandbox vs estimated vs declared. All three arrive from the same
--   authenticated user over the same path. The server has no way to tell a
--   real sandbox measurement from a number someone typed. These remain
--   client claims, and §9.7.1 publication is what makes them checkable — by
--   third parties recomputing, not by this trigger.
--
-- That asymmetry is the point of recording the method at all: binding_runtime
-- is attested, the rest are asserted, and the three-tier board (3.1) must
-- rank them accordingly rather than treating the column as uniformly true.
--
-- Additive per ADR-295: one new function, one new trigger. No column
-- changed, no row touched, no existing policy altered.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_arena_provenance()
RETURNS TRIGGER AS $$
DECLARE
  v_role TEXT := coalesce(auth.role(), '');
  v_uid  UUID := auth.uid();
BEGIN
  -- A request bearing one of these roles came through PostgREST from a
  -- client. Anything else (service_role, or a direct/superuser session such
  -- as a migration or backfill) is server-side and may attest.
  IF v_role IN ('authenticated', 'anon') THEN
    IF NEW.evaluation_method = 'binding_runtime' THEN
      RAISE EXCEPTION
        'evaluation_method=binding_runtime is attested by the binding, not chosen by clients (ADR-319 D2)'
        USING ERRCODE = '42501';
    END IF;

    -- "Who measured this" is not something the measurer gets to claim.
    -- Overwrite rather than validate: there is no legitimate reason for a
    -- client to name anyone but itself, so there is nothing to negotiate.
    IF v_uid IS NOT NULL THEN
      NEW.evaluator := v_uid::TEXT;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

DROP TRIGGER IF EXISTS trg_enforce_arena_provenance ON arena_entries;
CREATE TRIGGER trg_enforce_arena_provenance
  BEFORE INSERT OR UPDATE ON arena_entries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_arena_provenance();

COMMENT ON FUNCTION enforce_arena_provenance() IS
  'ADR-319 D2: refuses binding_runtime from client roles and stamps evaluator from the authenticated principal. Cannot distinguish sandbox/estimated/declared — those stay client claims, checkable only by §9.7.1 recomputation.';
