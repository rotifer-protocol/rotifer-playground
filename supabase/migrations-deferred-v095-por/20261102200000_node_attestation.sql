-- ============================================================
-- Node attestation (Proof of Registration) — v0.9.5 A1, Cloud side
-- ADR-300 revision 2, locked contract v2: "表", "发证挑战", D5
-- ============================================================
--
-- DEFERRED. This file is in supabase/migrations-deferred-v095-por/, not in
-- supabase/migrations/, so `supabase db push` never sees it. It moves to
-- supabase/migrations/ only with the user's keyword for v0.9.5 stage 2 B1
-- (README in this directory).
--
-- Four tables:
--   nodes                         peer_id -> user_id, account pseudonym, current
--                                 certificate. The owner reads their own rows.
--   node_attestation_issuances    one row per signed certificate, append-only.
--                                 D5 counts here, so replacing or deleting a
--                                 nodes row frees no slot: the certificate it
--                                 described still works on the network.
--   node_attestation_challenges   one-time nonces, valid <= 5 minutes.
--   node_attestation_revocations  the database side of the JWKS rotifer_revoked
--                                 list; a revoked certificate stops counting.
--
-- Writes go only through the SECURITY DEFINER functions below, which only
-- por_issuer may execute, a role made for the edge function and able to do
-- nothing else: the function verifies the node's signature first, then
-- records. anon and authenticated cannot write anything here —
-- were the record step open to them, a caller could skip the signature check
-- and claim another node's PeerId, and the rebinding rule would then lock the
-- real owner out.
--
-- Times are unix seconds (bigint), as in the token, so the database and the
-- token never disagree through a time zone or rounding.

CREATE TABLE node_attestation_challenges (
  nonce         BYTEA PRIMARY KEY CHECK (octet_length(nonce) = 32),
  user_id       UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  aud           TEXT NOT NULL CHECK (octet_length(aud) BETWEEN 1 AND 512),
  challenge_exp BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at   TIMESTAMPTZ
);
CREATE INDEX node_attestation_challenges_open_idx
  ON node_attestation_challenges (user_id) WHERE consumed_at IS NULL;

COMMENT ON TABLE node_attestation_challenges IS
  'PoR one-time challenges (ADR-300 contract v2 "发证挑战"). A nonce is consumed by the first redemption that reaches node_attestation_issue, refused or not.';

-- user_id has no foreign key on purpose: an issued certificate stays usable on
-- the network until it expires, whatever happens to the account row, so its
-- record must stay too.
CREATE TABLE node_attestation_issuances (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  peer_id   TEXT NOT NULL CHECK (peer_id ~ '^[1-9A-HJ-NP-Za-km-z]{46,60}$'),
  user_id   UUID NOT NULL,
  iat       BIGINT NOT NULL,
  exp       BIGINT NOT NULL,
  kid       TEXT NOT NULL CHECK (octet_length(kid) BETWEEN 1 AND 256),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (exp > iat AND exp - iat <= 604800)
);
CREATE INDEX node_attestation_issuances_user_idx ON node_attestation_issuances (user_id, exp);
CREATE INDEX node_attestation_issuances_peer_idx ON node_attestation_issuances (peer_id, exp);

COMMENT ON TABLE node_attestation_issuances IS
  'Append-only: one row per PoR certificate signed (ADR-300 contract v2 "表"). The per-account limit (D5) counts here.';

CREATE TABLE node_attestation_revocations (
  peer_id    TEXT NOT NULL CHECK (peer_id ~ '^[1-9A-HJ-NP-Za-km-z]{46,60}$'),
  not_after  BIGINT NOT NULL CHECK (not_after >= 0),
  reason     TEXT CHECK (octet_length(reason) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (peer_id, not_after)
);

COMMENT ON TABLE node_attestation_revocations IS
  'Every certificate for peer_id with iat <= not_after is void. Source of the JWKS rotifer_revoked list (node_attestation_revocations_for_jwks).';

CREATE TABLE nodes (
  peer_id    TEXT PRIMARY KEY CHECK (peer_id ~ '^[1-9A-HJ-NP-Za-km-z]{46,60}$'),
  user_id    UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  sub        TEXT NOT NULL CHECK (sub ~ '^[A-Za-z0-9_-]{43}$'),
  cert_iat   BIGINT NOT NULL,
  cert_exp   BIGINT NOT NULL,
  cert_kid   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX nodes_user_idx ON nodes (user_id);

COMMENT ON TABLE nodes IS
  'PoR: peer_id <-> user_id <-> account pseudonym (sub) <-> current certificate (ADR-300 contract v2 "表"). Owner reads own rows; written only by node_attestation_issue.';

-- ── Privileges and RLS ─────────────────────────────────────

ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_attestation_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_attestation_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_attestation_revocations ENABLE ROW LEVEL SECURITY;

-- ── The issuing role ──────────────────────────────────────
-- The edge function connects as por_issuer. It may execute the four PoR
-- functions (challenge, issue, revoke, revocations for the JWKS file) and
-- nothing else: no table privilege, no other function, no RLS bypass. So the
-- function holds no key that can read or write a table directly. The
-- migration creates it without LOGIN; the deployment gives it a password and
-- the function a connection string (README in this directory). Roles belong
-- to the cluster, not the database, so create it only once.
--
-- Supabase's default privileges also grant EXECUTE on every new function to
-- service_role; each function below takes that back explicitly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'por_issuer') THEN
    CREATE ROLE por_issuer NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- Supabase's default privileges grant every new table to anon, authenticated
-- and service_role; take them all back, then give back the one read.
REVOKE ALL ON nodes, node_attestation_issuances, node_attestation_challenges, node_attestation_revocations
  FROM PUBLIC, anon, authenticated, service_role, por_issuer;
GRANT SELECT ON nodes TO authenticated;

CREATE POLICY "Owners read their own nodes" ON nodes
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- ── Append-only issuance log ──────────────────────────────

CREATE OR REPLACE FUNCTION node_attestation_issuances_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'node_attestation_issuances is append-only (ADR-300 D5): a signed certificate stays usable until it expires'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER node_attestation_issuances_no_update_delete
  BEFORE UPDATE OR DELETE ON node_attestation_issuances
  FOR EACH ROW EXECUTE FUNCTION node_attestation_issuances_append_only();
CREATE TRIGGER node_attestation_issuances_no_truncate
  BEFORE TRUNCATE ON node_attestation_issuances
  FOR EACH STATEMENT EXECUTE FUNCTION node_attestation_issuances_append_only();

REVOKE ALL ON FUNCTION node_attestation_issuances_append_only() FROM PUBLIC, anon, authenticated, service_role;

-- ── Helpers ──────────────────────────────────────────────

-- Open = has an auth row, not soft-deleted, not banned, profile not closed.
CREATE OR REPLACE FUNCTION node_attestation_account_open(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
     WHERE u.id = p_user_id
       AND u.deleted_at IS NULL
       AND (u.banned_until IS NULL OR u.banned_until <= now())
       AND p.closed_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION node_attestation_account_open(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ── node_attestation_challenge ────────────────────────────
-- Step 1 of the contract: a 32-byte one-time nonce and its deadline (now + 300 s).
-- At most 5 open challenges per account; expired and consumed ones are cleared.

CREATE OR REPLACE FUNCTION node_attestation_challenge(p_user_id UUID, p_aud TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now   BIGINT := floor(extract(epoch FROM now()))::BIGINT;
  v_nonce BYTEA;
  v_exp   BIGINT := floor(extract(epoch FROM now()))::BIGINT + 300;
BEGIN
  IF p_user_id IS NULL OR p_aud IS NULL OR octet_length(p_aud) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'node_attestation_challenge: user and aud are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rotifer-por-user:' || p_user_id::TEXT, 0));
  IF NOT public.node_attestation_account_open(p_user_id) THEN
    RETURN jsonb_build_object('error', 'POR_ACCOUNT_CLOSED');
  END IF;
  DELETE FROM public.node_attestation_challenges
   WHERE user_id = p_user_id AND (consumed_at IS NOT NULL OR challenge_exp < v_now);
  IF (SELECT count(*) FROM public.node_attestation_challenges WHERE user_id = p_user_id) >= 5 THEN
    RETURN jsonb_build_object('error', 'POR_TOO_MANY_CHALLENGES');
  END IF;
  v_nonce := extensions.gen_random_bytes(32);
  INSERT INTO public.node_attestation_challenges (nonce, user_id, aud, challenge_exp)
  VALUES (v_nonce, p_user_id, p_aud, v_exp);
  RETURN jsonb_build_object('nonce', encode(v_nonce, 'hex'), 'challenge_exp', v_exp);
END;
$$;

REVOKE ALL ON FUNCTION node_attestation_challenge(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION node_attestation_challenge(UUID, TEXT) TO por_issuer;

-- ── node_attestation_issue ────────────────────────────────
-- Step 3, after the edge function has derived the PeerId from the public key
-- and verified the node's signature over the challenge bytes. In one
-- transaction: consume the nonce, re-check the account, refuse a rebinding,
-- apply the per-account limit, record. Locks: the PeerId first, then the
-- account, always in that order, so two redemptions for one account (or for
-- one PeerId) run one after the other and neither can miss the other's row.
--
-- Refusals are returned as {"error": code}, not raised, so the consumed nonce
-- stays consumed. Codes:
--   POR_CHALLENGE_INVALID     unknown, already used, or not this account's / this aud's / this deadline
--   POR_CHALLENGE_EXPIRED     past challenge_exp (consumed anyway)
--   POR_ACCOUNT_CLOSED        closed, banned or deleted
--   POR_PEER_BOUND_ELSEWHERE  another account holds a live certificate for this PeerId
--   POR_PEER_REVOKED          a revocation would void the new certificate on arrival
--   POR_QUOTA_EXCEEDED        3 other PeerIds already hold live certificates

CREATE OR REPLACE FUNCTION node_attestation_issue(
  p_user_id UUID, p_aud TEXT, p_nonce BYTEA, p_challenge_exp BIGINT,
  p_peer_id TEXT, p_sub TEXT, p_iat BIGINT, p_exp BIGINT, p_kid TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now      BIGINT := floor(extract(epoch FROM now()))::BIGINT;
  v_consumed BIGINT;
  v_live     INT;
BEGIN
  IF p_user_id IS NULL OR p_aud IS NULL OR p_nonce IS NULL OR p_challenge_exp IS NULL OR p_peer_id IS NULL
     OR p_sub IS NULL OR p_iat IS NULL OR p_exp IS NULL OR p_kid IS NULL THEN
    RAISE EXCEPTION 'node_attestation_issue: every argument is required' USING ERRCODE = '22023';
  END IF;
  -- The token's lifetime is fixed by the contract; the caller's clock may
  -- differ from ours by the verifier skew at most.
  IF p_exp - p_iat <> 604800 OR abs(p_iat - v_now) > 60 THEN
    RAISE EXCEPTION 'node_attestation_issue: iat must be now (±60 s) and exp = iat + 7 days' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rotifer-por-peer:' || p_peer_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('rotifer-por-user:' || p_user_id::TEXT, 0));

  UPDATE public.node_attestation_challenges
     SET consumed_at = now()
   WHERE nonce = p_nonce AND user_id = p_user_id AND aud = p_aud
     AND challenge_exp = p_challenge_exp AND consumed_at IS NULL
  RETURNING challenge_exp INTO v_consumed;
  IF v_consumed IS NULL THEN
    RETURN jsonb_build_object('error', 'POR_CHALLENGE_INVALID');
  END IF;
  IF v_consumed < v_now THEN
    RETURN jsonb_build_object('error', 'POR_CHALLENGE_EXPIRED');
  END IF;

  IF NOT public.node_attestation_account_open(p_user_id) THEN
    RETURN jsonb_build_object('error', 'POR_ACCOUNT_CLOSED');
  END IF;

  IF EXISTS (SELECT 1 FROM public.node_attestation_revocations r
              WHERE r.peer_id = p_peer_id AND p_iat <= r.not_after) THEN
    RETURN jsonb_build_object('error', 'POR_PEER_REVOKED');
  END IF;

  -- "Live" = a verifier would still accept it: exp + 60 s skew not passed, not revoked.
  IF EXISTS (
    SELECT 1 FROM public.node_attestation_issuances i
     WHERE i.peer_id = p_peer_id AND i.user_id <> p_user_id AND i.exp + 60 >= v_now
       AND NOT EXISTS (SELECT 1 FROM public.node_attestation_revocations r
                        WHERE r.peer_id = i.peer_id AND i.iat <= r.not_after)
  ) THEN
    RETURN jsonb_build_object('error', 'POR_PEER_BOUND_ELSEWHERE');
  END IF;

  -- D5: distinct PeerIds, renewal of the same PeerId takes no extra slot.
  SELECT count(DISTINCT i.peer_id) INTO v_live
    FROM public.node_attestation_issuances i
   WHERE i.user_id = p_user_id AND i.peer_id <> p_peer_id AND i.exp + 60 >= v_now
     AND NOT EXISTS (SELECT 1 FROM public.node_attestation_revocations r
                      WHERE r.peer_id = i.peer_id AND i.iat <= r.not_after);
  IF v_live >= 3 THEN
    RETURN jsonb_build_object('error', 'POR_QUOTA_EXCEEDED');
  END IF;

  INSERT INTO public.node_attestation_issuances (peer_id, user_id, iat, exp, kid)
  VALUES (p_peer_id, p_user_id, p_iat, p_exp, p_kid);

  INSERT INTO public.nodes (peer_id, user_id, sub, cert_iat, cert_exp, cert_kid)
  VALUES (p_peer_id, p_user_id, p_sub, p_iat, p_exp, p_kid)
  ON CONFLICT (peer_id) DO UPDATE
    SET user_id = EXCLUDED.user_id, sub = EXCLUDED.sub, cert_iat = EXCLUDED.cert_iat,
        cert_exp = EXCLUDED.cert_exp, cert_kid = EXCLUDED.cert_kid, updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION node_attestation_issue(UUID, TEXT, BYTEA, BIGINT, TEXT, TEXT, BIGINT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION node_attestation_issue(UUID, TEXT, BYTEA, BIGINT, TEXT, TEXT, BIGINT, BIGINT, TEXT)
  TO por_issuer;

-- ── Revocation ────────────────────────────────────────────
-- For a banned account, a leaked identity.key, or a node that replaced its
-- identity.key (the old PeerId's certificates stay valid otherwise; ADR-300
-- D4 revision 2). not_after defaults to now: every certificate issued so far.

CREATE OR REPLACE FUNCTION node_attestation_revoke(p_peer_id TEXT, p_not_after BIGINT DEFAULT NULL, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.node_attestation_revocations (peer_id, not_after, reason)
  VALUES (p_peer_id, coalesce(p_not_after, floor(extract(epoch FROM now()))::BIGINT), p_reason)
  ON CONFLICT (peer_id, not_after) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION node_attestation_revoke(TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION node_attestation_revoke(TEXT, BIGINT, TEXT) TO por_issuer;

-- The list for scripts/por-jwks.ts --revoked: one entry per PeerId (latest
-- not_after), only while some certificate it voids could still be accepted
-- (not_after + 7 days + 60 s).
CREATE OR REPLACE FUNCTION node_attestation_revocations_for_jwks()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('peer_id', peer_id, 'not_after', not_after) ORDER BY peer_id), '[]'::jsonb)
    FROM (SELECT peer_id, max(not_after) AS not_after
            FROM public.node_attestation_revocations
           GROUP BY peer_id) latest
   WHERE not_after + 604800 + 60 >= floor(extract(epoch FROM now()))::BIGINT;
$$;

REVOKE ALL ON FUNCTION node_attestation_revocations_for_jwks() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION node_attestation_revocations_for_jwks() TO por_issuer;
