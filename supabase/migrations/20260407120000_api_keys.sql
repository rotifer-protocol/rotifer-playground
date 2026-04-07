-- Evolution API key management (ADR-213)
-- Replaces static Worker secret API_KEYS with DB-backed, KV-cached key system.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix char(8) NOT NULL,
  name text NOT NULL,
  scopes text[] DEFAULT '{read}' NOT NULL,
  rate_limit_per_min int DEFAULT 30 NOT NULL CHECK (rate_limit_per_min > 0 AND rate_limit_per_min <= 1000),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  total_requests bigint DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX idx_api_keys_owner ON api_keys (owner_id);
CREATE INDEX idx_api_keys_hash ON api_keys (key_hash);

COMMENT ON TABLE api_keys IS 'Evolution API keys — hash stored, no plaintext. ADR-213.';
COMMENT ON COLUMN api_keys.key_hash IS 'SHA-256 hash of the full API key. Plaintext shown once at creation.';
COMMENT ON COLUMN api_keys.key_prefix IS 'First 8 chars of the key (e.g. rk_a1b2) for UI identification.';
COMMENT ON COLUMN api_keys.scopes IS 'Granted scopes: read (L1.5), execute (L2), agent:write (L3).';

-- RLS: users manage own keys only
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own keys"
  ON api_keys FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY "Users can insert own keys"
  ON api_keys FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users can update own keys"
  ON api_keys FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "Users can delete own keys"
  ON api_keys FOR DELETE
  USING (owner_id = auth.uid());

-- Service role bypass for admin dashboard
CREATE POLICY "Service role full access"
  ON api_keys FOR ALL
  USING (auth.role() = 'service_role');

-- RPC to validate a key hash without exposing table directly.
-- Used by Evolution API Worker via service_role.
CREATE OR REPLACE FUNCTION validate_api_key(p_key_hash text)
RETURNS TABLE (
  key_id uuid,
  owner_id uuid,
  scopes text[],
  rate_limit_per_min int,
  revoked boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    id AS key_id,
    owner_id,
    scopes,
    rate_limit_per_min,
    (revoked_at IS NOT NULL) AS revoked
  FROM api_keys
  WHERE key_hash = p_key_hash
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION validate_api_key(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION validate_api_key(text) TO service_role;

-- RPC to bump usage stats (called by Worker in batches)
CREATE OR REPLACE FUNCTION bump_api_key_usage(p_key_hash text, p_count bigint DEFAULT 1)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE api_keys
  SET last_used_at = now(),
      total_requests = total_requests + p_count
  WHERE key_hash = p_key_hash;
$$;

REVOKE EXECUTE ON FUNCTION bump_api_key_usage(text, bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION bump_api_key_usage(text, bigint) TO service_role;
