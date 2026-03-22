-- ============================================================
-- Migration: Data Pipeline Triggers & track_download RPC
-- Rotifer Protocol v0.8
--
-- Fixes 6 CRITICAL data pipeline breaks identified in audit:
--   1. track_download RPC missing → MCP server calls silently fail
--   2. genes.downloads never incremented → always 0
--   3. gene_reputation never auto-refreshed → stale scores
--   4. developer_reputation never auto-refreshed → stale leaderboard
--   5. domain_registry.gene_count never auto-updated → stale counts
--   6. Arena results don't cascade to reputation → wins not reflected
--
-- Trigger chain (no loops — verified):
--
--   track_download(gene_id)
--     → INSERT downloads
--       → [trg] genes.downloads++
--
--   genes INSERT/UPDATE(published)
--     → [trg] compute_gene_reputation
--       → INSERT gene_reputation
--         → [trg] compute_developer_reputation
--     → [trg] update domain_registry.gene_count
--
--   arena_entries INSERT
--     → [trg] compute_gene_reputation (for the gene)
--       → INSERT gene_reputation
--         → [trg] compute_developer_reputation
--
-- Loop prevention:
--   - genes trigger only fires on INSERT or UPDATE OF 'published' column
--   - compute_gene_reputation updates genes.reputation_score but NOT published
--   - Therefore no re-trigger on genes
-- ============================================================

BEGIN;

-- =====================
-- 1. track_download RPC
--    - Dedup: authenticated user × gene × 24h = max 1 record
--    - Anon callers: allowed but no dedup (rely on rate limiting)
--    - Does NOT directly increment genes.downloads (trigger handles it)
-- =====================

CREATE OR REPLACE FUNCTION track_download(p_gene_id UUID)
RETURNS VOID AS $$
DECLARE
  v_caller UUID;
BEGIN
  v_caller := auth.uid();

  IF v_caller IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM downloads
      WHERE gene_id = p_gene_id
        AND user_id = v_caller
        AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN;
    END IF;

    INSERT INTO downloads (gene_id, user_id)
    VALUES (p_gene_id, v_caller);
  ELSE
    INSERT INTO downloads (gene_id, ip_hash)
    VALUES (p_gene_id, 'anon-' || substr(md5(inet_client_addr()::text || now()::text), 1, 8));
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

REVOKE EXECUTE ON FUNCTION track_download(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION track_download(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION track_download(UUID) TO anon;

-- =====================
-- 2. Trigger: downloads INSERT → genes.downloads++
--    Single source of truth for incrementing the counter.
-- =====================

CREATE OR REPLACE FUNCTION fn_increment_gene_downloads()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE genes SET downloads = downloads + 1 WHERE id = NEW.gene_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

CREATE TRIGGER trg_increment_gene_downloads
  AFTER INSERT ON downloads
  FOR EACH ROW EXECUTE FUNCTION fn_increment_gene_downloads();

-- =====================
-- 3. Trigger: genes published → compute_gene_reputation
--    Only fires on INSERT or change to 'published' column.
--    Does NOT fire when reputation_score is updated (loop prevention).
-- =====================

CREATE OR REPLACE FUNCTION fn_gene_published_reputation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.published = true THEN
    PERFORM compute_gene_reputation(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

CREATE TRIGGER trg_gene_published_reputation
  AFTER INSERT OR UPDATE OF published ON genes
  FOR EACH ROW
  WHEN (NEW.published = true)
  EXECUTE FUNCTION fn_gene_published_reputation();

-- =====================
-- 4. Trigger: gene_reputation INSERT → compute_developer_reputation
--    Cascades gene score changes to developer aggregate.
-- =====================

CREATE OR REPLACE FUNCTION fn_gene_rep_cascade_developer()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  SELECT owner_id INTO v_owner_id FROM genes WHERE id = NEW.gene_id;
  IF v_owner_id IS NOT NULL THEN
    PERFORM compute_developer_reputation(v_owner_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

CREATE TRIGGER trg_gene_rep_cascade_developer
  AFTER INSERT ON gene_reputation
  FOR EACH ROW EXECUTE FUNCTION fn_gene_rep_cascade_developer();

-- =====================
-- 5. Trigger: arena_entries INSERT → compute_gene_reputation
--    Arena results should update the gene's arena_score.
-- =====================

CREATE OR REPLACE FUNCTION fn_arena_entry_reputation()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM compute_gene_reputation(NEW.gene_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

CREATE TRIGGER trg_arena_entry_reputation
  AFTER INSERT ON arena_entries
  FOR EACH ROW EXECUTE FUNCTION fn_arena_entry_reputation();

-- =====================
-- 6. Trigger: genes published/domain change → domain_registry.gene_count
-- =====================

CREATE OR REPLACE FUNCTION fn_update_domain_gene_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.published = true THEN
    INSERT INTO domain_registry (domain, gene_count)
    VALUES (NEW.domain, 1)
    ON CONFLICT (domain) DO UPDATE
    SET gene_count = (
      SELECT COUNT(DISTINCT (g.owner_id, g.name))::integer
      FROM genes g WHERE g.domain = NEW.domain AND g.published = true
    );

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.published IS DISTINCT FROM NEW.published
       OR OLD.domain IS DISTINCT FROM NEW.domain THEN

      IF OLD.domain IS NOT NULL THEN
        UPDATE domain_registry
        SET gene_count = (
          SELECT COALESCE(COUNT(DISTINCT (g.owner_id, g.name)), 0)::integer
          FROM genes g WHERE g.domain = OLD.domain AND g.published = true
        )
        WHERE domain = OLD.domain;
      END IF;

      IF NEW.published = true THEN
        INSERT INTO domain_registry (domain, gene_count)
        VALUES (NEW.domain, 1)
        ON CONFLICT (domain) DO UPDATE
        SET gene_count = (
          SELECT COUNT(DISTINCT (g.owner_id, g.name))::integer
          FROM genes g WHERE g.domain = NEW.domain AND g.published = true
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = 'public';

CREATE TRIGGER trg_update_domain_gene_count
  AFTER INSERT OR UPDATE OF published, domain ON genes
  FOR EACH ROW EXECUTE FUNCTION fn_update_domain_gene_count();

-- =====================
-- 7. One-time recomputation
--    Order: gene_reputation → developer_reputation → domain_registry
-- =====================

-- 7a. Recompute gene reputation for latest version of each published gene
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (owner_id, name) id
    FROM genes
    WHERE published = true
    ORDER BY owner_id, name, created_at DESC
  LOOP
    PERFORM compute_gene_reputation(r.id);
  END LOOP;
END;
$$;

-- 7b. Recompute developer reputation for all developers with published genes
-- (also triggered by 7a via cascade, but explicit call ensures consistency)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_id FROM genes WHERE published = true
  LOOP
    PERFORM compute_developer_reputation(r.owner_id);
  END LOOP;
END;
$$;

-- 7c. Recount domain_registry.gene_count for all domains
UPDATE domain_registry dr
SET gene_count = sub.cnt
FROM (
  SELECT g.domain, COUNT(DISTINCT (g.owner_id, g.name))::integer AS cnt
  FROM genes g
  WHERE g.published = true
  GROUP BY g.domain
) sub
WHERE dr.domain = sub.domain;

COMMIT;
