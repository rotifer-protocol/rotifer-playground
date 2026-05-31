-- Revoke anon/authenticated EXECUTE on the API-key SECURITY DEFINER helpers (hardening).
--
-- Supabase advisor flagged validate_api_key(text) and bump_api_key_usage(text, bigint)
-- as SECURITY DEFINER functions executable by anon/authenticated. Postgres grants
-- EXECUTE to PUBLIC by default, so these were reachable by anon even though the only
-- real caller does not need that grant.
--
-- Caller verified: the Evolution API gateway (Cloudflare Worker) calls both RPCs with
-- the service_role key (Authorization: Bearer SERVICE_ROLE_KEY), which bypasses this
-- grant. Removing anon/authenticated EXECUTE therefore does NOT affect the gateway and
-- closes the residual stat-pollution vector (an anon who knows a key_hash could otherwise
-- inflate that key's usage counters via bump_api_key_usage).
--
-- Tightening-only; matches the existing 20260228130000_revoke_anon_execute.sql pattern.
-- Ref: Supabase database-linter (anon/authenticated_security_definer_function_executable)

REVOKE EXECUTE ON FUNCTION public.bump_api_key_usage(text, bigint) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM anon, authenticated;
