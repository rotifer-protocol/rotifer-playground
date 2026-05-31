-- Correctly restrict EXECUTE on the API-key SECURITY DEFINER helpers (hardening).
--
-- Supersedes 20260531020500 (which revoked FROM anon, authenticated only — a no-op,
-- because anon/authenticated inherit EXECUTE via the PUBLIC grant, so
-- has_function_privilege still returned true). Verified post-apply: anon/auth EXECUTE
-- was still true. The grant must be revoked FROM PUBLIC.
--
-- Because service_role's EXECUTE may also be inherited via PUBLIC, we REVOKE FROM PUBLIC
-- and then explicitly GRANT TO service_role so the only real caller keeps access.
--
-- Caller verified: the Evolution API gateway (Cloudflare Worker) calls both RPCs with
-- the service_role key, so granting EXECUTE to service_role preserves gateway behavior
-- while closing anon/authenticated access (and the bump_api_key_usage stat-pollution vector).
--
-- Tightening-only. Ref: Supabase database-linter
-- (anon/authenticated_security_definer_function_executable)

BEGIN;

REVOKE EXECUTE ON FUNCTION public.bump_api_key_usage(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bump_api_key_usage(text, bigint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;

COMMIT;
