-- ============================================================
-- Mirror of a migration that was applied to production outside this repo.
--
-- Production's supabase_migrations ledger carries version 20260630123659
-- (name: blog_publish_preserve_cover_fields, applied 2026-06-30 12:36:59) but
-- no such file existed here, so `supabase db push --linked` refused to run at
-- all: "Remote migration versions not found in local migrations directory."
--
-- The body below is the verbatim statement array read back out of that ledger
-- row — not a reconstruction. Committing it restores parity so pushes work,
-- and pays down one unit of the reverse-parity debt that migration
-- 20260531022500 already flagged ("missing CREATE migrations — tracked
-- separately").
--
-- Note it is idempotent (CREATE OR REPLACE + GRANT), and production already
-- has this version recorded, so `db push` skips it there. It only matters for
-- fresh replays (local, CI).
--
-- ⚠️ Still missing from this repo: the CREATE TABLE migrations for
-- blog_posts / blog_publisher_tokens, which this function references. A fresh
-- replay creates the function anyway (plpgsql bodies are not resolved at
-- CREATE time), so the suite stays green — but the repo is still not a
-- complete record of production schema.
-- ============================================================

CREATE OR REPLACE FUNCTION publish_blog_post(post jsonb, secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  token_valid boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM blog_publisher_tokens
    WHERE token = secret
      AND NOT revoked
      AND (expires_at IS NULL OR expires_at > now())
  ) INTO token_valid;

  IF NOT token_valid THEN
    RAISE EXCEPTION 'invalid or revoked publisher token'
      USING ERRCODE = '42501';
  END IF;

  IF post->>'slug' IS NULL OR post->>'locale' IS NULL THEN
    RAISE EXCEPTION 'post must include slug and locale fields'
      USING ERRCODE = '23502';
  END IF;

  INSERT INTO blog_posts (
    slug, locale, title, description, published_at,
    authors, category, tags, image, canonical_url,
    featured, draft, display_order, body_md, body_html,
    cover_main, cover_sub
  )
  VALUES (
    post->>'slug',
    post->>'locale',
    COALESCE(post->>'title', post->>'slug'),
    COALESCE(post->>'description', ''),
    COALESCE((post->>'published_at')::timestamptz, now()),
    COALESCE(
      (SELECT array_agg(value) FROM jsonb_array_elements_text(post->'authors')),
      ARRAY['rotifer-protocol']::text[]
    ),
    COALESCE(post->>'category', 'deep-dive'),
    COALESCE(
      (SELECT array_agg(value) FROM jsonb_array_elements_text(post->'tags')),
      '{}'::text[]
    ),
    post->>'image',
    post->>'canonical_url',
    COALESCE((post->>'featured')::boolean, false),
    COALESCE((post->>'draft')::boolean, false),
    COALESCE((post->>'display_order')::int, 0),
    COALESCE(post->>'body_md', ''),
    COALESCE(post->>'body_html', ''),
    NULLIF(post->>'cover_main', ''),
    NULLIF(post->>'cover_sub', '')
  )
  ON CONFLICT (slug, locale) DO UPDATE SET
    title           = EXCLUDED.title,
    description     = EXCLUDED.description,
    published_at    = EXCLUDED.published_at,
    authors         = EXCLUDED.authors,
    category        = EXCLUDED.category,
    tags            = EXCLUDED.tags,
    image           = COALESCE(NULLIF(EXCLUDED.image, ''), blog_posts.image),
    canonical_url   = EXCLUDED.canonical_url,
    featured        = EXCLUDED.featured,
    draft           = EXCLUDED.draft,
    display_order   = EXCLUDED.display_order,
    body_md         = EXCLUDED.body_md,
    body_html       = EXCLUDED.body_html,
    cover_main      = COALESCE(NULLIF(EXCLUDED.cover_main, ''), blog_posts.cover_main),
    cover_sub       = COALESCE(NULLIF(EXCLUDED.cover_sub, ''), blog_posts.cover_sub);
END;
$$;

GRANT EXECUTE ON FUNCTION publish_blog_post(jsonb, text) TO anon, authenticated;
