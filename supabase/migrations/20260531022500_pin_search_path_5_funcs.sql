-- Pin search_path on 5 functions flagged function_search_path_mutable (hardening).
--
-- Supabase advisor 0011_function_search_path_mutable: a function without a fixed
-- search_path resolves unqualified names against the caller's search_path, opening
-- a theoretical search-path hijack vector (strongest for SECURITY DEFINER funcs).
--
-- Per-function strategy (function bodies were inspected before choosing the value;
-- search_path = '' forces full qualification and is the gold standard, but breaks
-- functions that reference public objects unqualified):
--
--   handle_new_user()              SECURITY DEFINER, refs public.profiles (qualified) -> '' safe
--   set_share_ip()                 trigger, inet_client_addr() builtin only           -> '' safe
--   update_blog_posts_updated_at() trigger, now() builtin only                        -> '' safe
--   get_gene_stats(uuid)           SECURITY DEFINER, refs genes/downloads UNqualified -> qualify + ''
--   jsonb_to_compact(jsonb)        IMMUTABLE (not definer), recursive self-call only;
--                                  pg_temp is never searched for functions, so 'public'
--                                  fully pins it without a body rewrite               -> 'public'
--
-- Tightening-only: no privilege or data changes.
-- Ref: Supabase database-linter 0011_function_search_path_mutable

BEGIN;

-- Guard each ALTER with an existence check: some of these functions exist in
-- production but predate the local migration chain (created via dashboard /
-- orphan migrations), so a from-scratch replay (CI) must skip the ones that
-- aren't present. In production all exist and get pinned; semantics unchanged.
-- (Underlying reverse-parity debt — missing CREATE migrations — is tracked
-- separately; this only restores replay-safety.)
DO $$
BEGIN
  -- handle_new_user / set_share_ip / update_blog_posts_updated_at: safe to pin to ''
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'handle_new_user') THEN
    ALTER FUNCTION public.handle_new_user() SET search_path = '';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'set_share_ip') THEN
    ALTER FUNCTION public.set_share_ip() SET search_path = '';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'update_blog_posts_updated_at') THEN
    ALTER FUNCTION public.update_blog_posts_updated_at() SET search_path = '';
  END IF;

  -- jsonb_to_compact: pin to public (recursive func call resolves; pg_temp never hijacks funcs)
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'jsonb_to_compact') THEN
    ALTER FUNCTION public.jsonb_to_compact(jsonb) SET search_path = 'public';
  END IF;
END $$;

-- get_gene_stats: fully-qualify table refs so '' (gold standard) works for this SECURITY DEFINER func
CREATE OR REPLACE FUNCTION public.get_gene_stats(p_gene_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
DECLARE
  v_total BIGINT;
  v_last_7d BIGINT;
  v_last_30d BIGINT;
  v_last_90d BIGINT;
BEGIN
  SELECT downloads INTO v_total FROM public.genes WHERE id = p_gene_id;

  SELECT COUNT(*) INTO v_last_7d
  FROM public.downloads
  WHERE gene_id = p_gene_id AND created_at >= now() - interval '7 days';

  SELECT COUNT(*) INTO v_last_30d
  FROM public.downloads
  WHERE gene_id = p_gene_id AND created_at >= now() - interval '30 days';

  SELECT COUNT(*) INTO v_last_90d
  FROM public.downloads
  WHERE gene_id = p_gene_id AND created_at >= now() - interval '90 days';

  RETURN json_build_object(
    'total', COALESCE(v_total, 0),
    'last_7d', COALESCE(v_last_7d, 0),
    'last_30d', COALESCE(v_last_30d, 0),
    'last_90d', COALESCE(v_last_90d, 0)
  );
END;
$function$;

COMMIT;
