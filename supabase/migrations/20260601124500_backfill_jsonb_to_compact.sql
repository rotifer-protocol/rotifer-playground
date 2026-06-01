-- Backfill CREATE for jsonb_to_compact(jsonb): a protocol-layer utility function
-- that exists in production but had no CREATE in the local migration chain
-- (created out-of-band — reverse-parity debt). Adding it lets a from-scratch
-- replay (CI / `supabase db reset`) reproduce the function.
--
-- Definition copied verbatim from production pg_get_functiondef(); search_path
-- already pinned to 'public' (matches the pin_search_path migration). Uses
-- CREATE OR REPLACE so replay is idempotent. In production the function already
-- exists with this exact definition, so this migration is recorded as applied
-- WITHOUT re-executing the DDL (see the migration parity audit doc) — that
-- avoids any risk of overwriting the known-good production function.

CREATE OR REPLACE FUNCTION public.jsonb_to_compact(val jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  result text;
  key text;
  items text[];
  item jsonb;
BEGIN
  CASE jsonb_typeof(val)
    WHEN 'object' THEN
      items := ARRAY[]::text[];
      FOR key IN SELECT k FROM jsonb_object_keys(val) k ORDER BY k
      LOOP
        items := items || ('"' || replace(replace(replace(replace(replace(key, E'\\', E'\\\\'), '"', E'\\"'), E'\n', E'\\n'), E'\r', E'\\r'), E'\t', E'\\t') || '":' || jsonb_to_compact(val -> key));
      END LOOP;
      RETURN '{' || array_to_string(items, ',') || '}';
    WHEN 'array' THEN
      items := ARRAY[]::text[];
      FOR item IN SELECT * FROM jsonb_array_elements(val)
      LOOP
        items := items || jsonb_to_compact(item);
      END LOOP;
      RETURN '[' || array_to_string(items, ',') || ']';
    WHEN 'string' THEN
      RETURN val::text;
    WHEN 'number' THEN
      result := val::text;
      IF result ~ '\\.' AND result ~ '\\.0$' THEN
        result := regexp_replace(result, '\\.0$', '');
      END IF;
      RETURN result;
    WHEN 'boolean' THEN
      RETURN val::text;
    WHEN 'null' THEN
      RETURN 'null';
    ELSE
      RETURN val::text;
  END CASE;
END;
$function$;
