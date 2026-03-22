-- ============================================================
-- Migration 007: Enable pgvector + doc_chunks table + match_documents RPC
-- Rotifer Protocol v0.7
--
-- Provides vector-based document retrieval for the Dogfooding
-- AI Documentation Assistant (RAG pipeline).
-- ============================================================

BEGIN;

-- Enable the pgvector extension (available on all Supabase plans)
CREATE EXTENSION IF NOT EXISTS vector;

-- Document chunks table for RAG retrieval.
-- Each row is a semantically meaningful fragment of protocol documentation.
CREATE TABLE IF NOT EXISTS doc_chunks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL,          -- e.g. "docs/getting-started.md"
    heading     TEXT,                   -- section heading for context
    embedding   vector(1536) NOT NULL,  -- text-embedding-3-small dimension
    metadata    JSONB DEFAULT '{}'::JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index for cosine similarity search (HNSW — no minimum row requirement unlike ivfflat)
CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding
    ON doc_chunks
    USING hnsw (embedding vector_cosine_ops);

-- Full-text search fallback
CREATE INDEX IF NOT EXISTS idx_doc_chunks_content_gin
    ON doc_chunks
    USING gin (to_tsvector('english', content));

-- Source lookup
CREATE INDEX IF NOT EXISTS idx_doc_chunks_source
    ON doc_chunks (source);

-- RLS: doc_chunks are publicly readable, only service_role can write
ALTER TABLE doc_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "doc_chunks_select_public"
    ON doc_chunks FOR SELECT
    USING (true);

CREATE POLICY "doc_chunks_insert_service_only"
    ON doc_chunks FOR INSERT
    WITH CHECK (false);

CREATE POLICY "doc_chunks_update_service_only"
    ON doc_chunks FOR UPDATE
    USING (false);

CREATE POLICY "doc_chunks_delete_service_only"
    ON doc_chunks FOR DELETE
    USING (false);

-- match_documents RPC: cosine similarity search
-- Called by the doc-retrieval Gene via Supabase REST API.
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding vector(1536),
    match_count INT DEFAULT 5,
    match_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
    id          BIGINT,
    content     TEXT,
    source      TEXT,
    heading     TEXT,
    similarity  FLOAT,
    metadata    JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        dc.id,
        dc.content,
        dc.source,
        dc.heading,
        1 - (dc.embedding <=> query_embedding) AS similarity,
        dc.metadata
    FROM doc_chunks dc
    WHERE 1 - (dc.embedding <=> query_embedding) > match_threshold
    ORDER BY dc.embedding <=> query_embedding
    LIMIT LEAST(match_count, 20);
END;
$$;

-- match_documents is public (read-only search)
GRANT EXECUTE ON FUNCTION match_documents(vector(1536), INT, FLOAT) TO anon;
GRANT EXECUTE ON FUNCTION match_documents(vector(1536), INT, FLOAT) TO authenticated;

COMMIT;
