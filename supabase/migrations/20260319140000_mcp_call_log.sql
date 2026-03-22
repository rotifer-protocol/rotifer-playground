-- ============================================================
-- Migration 014: MCP Call Log
-- Rotifer Protocol v0.7.5
--
-- Tracks MCP tool invocations for growth strategy measurement.
-- ============================================================

BEGIN;

CREATE TABLE mcp_call_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name  text NOT NULL,
  gene_id    text,
  success    boolean NOT NULL,
  latency_ms integer NOT NULL,
  caller     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mcp_call_log_tool ON mcp_call_log(tool_name, created_at);
CREATE INDEX idx_mcp_call_log_gene ON mcp_call_log(gene_id, created_at);
CREATE INDEX idx_mcp_call_log_created ON mcp_call_log(created_at);

ALTER TABLE mcp_call_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can insert call logs"
  ON mcp_call_log FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Only authenticated users can read call logs"
  ON mcp_call_log FOR SELECT
  USING (auth.role() = 'authenticated');

COMMIT;
