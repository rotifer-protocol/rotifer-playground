CREATE OR REPLACE FUNCTION get_gene_detail(p_identifier text)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_gene record;
  v_result json;
BEGIN
  IF p_identifier ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT g.*, p.username AS owner_username
    INTO v_gene
    FROM genes g
    JOIN profiles p ON g.owner_id = p.id
    WHERE g.id = p_identifier::uuid AND g.published = true;
  END IF;

  IF v_gene IS NULL THEN
    SELECT g.*, p.username AS owner_username
    INTO v_gene
    FROM genes g
    JOIN profiles p ON g.owner_id = p.id
    WHERE g.name = p_identifier AND g.published = true
    ORDER BY g.created_at DESC
    LIMIT 1;
  END IF;

  IF v_gene IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT json_build_object(
    'gene', json_build_object(
      'id', v_gene.id,
      'name', v_gene.name,
      'domain', v_gene.domain,
      'version', v_gene.version,
      'fidelity', v_gene.fidelity,
      'description', v_gene.description,
      'readme', v_gene.readme,
      'phenotype', v_gene.phenotype,
      'wasm_size', v_gene.wasm_size,
      'downloads', v_gene.downloads,
      'reputation_score', v_gene.reputation_score,
      'created_at', v_gene.created_at,
      'updated_at', v_gene.updated_at,
      'owner_username', v_gene.owner_username
    ),
    'arena', COALESCE((
      SELECT json_agg(row_to_json(a) ORDER BY a.last_evaluated DESC)
      FROM (
        SELECT gene_id, gene_name, domain, fitness_value, safety_score, total_calls, last_evaluated, created_at
        FROM arena_history
        WHERE gene_id = v_gene.id
        ORDER BY last_evaluated DESC
        LIMIT 50
      ) a
    ), '[]'::json),
    'reputation', (
      SELECT row_to_json(r)
      FROM (
        SELECT score, arena_score, usage_score, stability_score, epoch
        FROM gene_reputation
        WHERE gene_id = v_gene.id
        LIMIT 1
      ) r
    ),
    'versions', COALESCE((
      SELECT json_agg(row_to_json(v) ORDER BY v.created_at DESC)
      FROM (
        SELECT g2.id, g2.version, g2.changelog, g2.created_at,
               COALESCE(json_array_length(
                 CASE WHEN jsonb_typeof(g2.phenotype->'inputSchema'->'properties') = 'object'
                      THEN (SELECT json_agg(k)::json FROM jsonb_object_keys(g2.phenotype->'inputSchema'->'properties') k)
                      ELSE '[]'::json END
               ), 0) AS input_count,
               COALESCE(json_array_length(
                 CASE WHEN jsonb_typeof(g2.phenotype->'outputSchema'->'properties') = 'object'
                      THEN (SELECT json_agg(k)::json FROM jsonb_object_keys(g2.phenotype->'outputSchema'->'properties') k)
                      ELSE '[]'::json END
               ), 0) AS output_count
        FROM genes g2
        JOIN profiles p2 ON g2.owner_id = p2.id
        WHERE g2.name = v_gene.name
          AND p2.username = v_gene.owner_username
          AND g2.published = true
        ORDER BY g2.created_at DESC
      ) v
    ), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
