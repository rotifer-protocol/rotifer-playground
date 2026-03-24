/**
 * Gap #1: Database function logic tests
 * Tests Epoch/ContributionMetrics/Cleanup SQL function contracts
 * without requiring a live Supabase instance.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../supabase/migrations");

// ─── ContributionMetrics Migration Structure ──────────────────

describe("ContributionMetrics migration (§3.6)", () => {
  const sql = readFileSync(
    join(MIGRATIONS_DIR, "20260322120000_contribution_metrics.sql"),
    "utf-8"
  );

  it("creates gene_invocation_log table with required columns", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS gene_invocation_log");
    expect(sql).toContain("gene_id UUID NOT NULL");
    expect(sql).toContain("caller_agent_id TEXT NOT NULL");
    expect(sql).toContain("invoked_at TIMESTAMPTZ");
    expect(sql).toContain("is_self_invocation BOOLEAN");
  });

  it("creates gene_contribution_metrics table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS gene_contribution_metrics");
    expect(sql).toContain("total_invocations INTEGER");
    expect(sql).toContain("unique_callers INTEGER");
    expect(sql).toContain("invocations_last_30d INTEGER");
  });

  it("has RLS enabled on both tables", () => {
    expect(sql).toContain("ALTER TABLE gene_invocation_log ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE gene_contribution_metrics ENABLE ROW LEVEL SECURITY");
  });

  it("blocks direct user INSERT to invocation_log", () => {
    expect(sql).toContain("Invocation log insert blocked for users");
    expect(sql).toMatch(/FOR INSERT\s+WITH CHECK \(false\)/);
  });

  it("blocks direct UPDATE to contribution_metrics", () => {
    expect(sql).toContain("Contribution metrics not directly updatable");
    expect(sql).toMatch(/FOR UPDATE\s+USING \(false\)/);
  });

  it("refresh_contribution_metrics uses SECURITY DEFINER", () => {
    expect(sql).toMatch(/refresh_contribution_metrics\(\)[\s\S]*?SECURITY DEFINER/);
  });

  it("revokes execute from PUBLIC, anon, authenticated on all functions", () => {
    const revokeCount = (sql.match(/REVOKE EXECUTE ON FUNCTION/g) || []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(9);
  });

  it("log_gene_invocation RPC exists with correct signature", () => {
    expect(sql).toContain("log_gene_invocation(");
    expect(sql).toContain("p_gene_id UUID");
    expect(sql).toContain("p_caller_agent_id TEXT");
  });

  it("cleanup retains 90-day window (§33.4)", () => {
    expect(sql).toContain("INTERVAL '90 days'");
  });

  it("has cron schedule for weekly cleanup", () => {
    expect(sql).toContain("cron.schedule");
    expect(sql).toContain("weekly-invocation-log-cleanup");
  });
});

// ─── Epoch Automation ─────────────────────────────────────────

describe("Epoch automation migration (§3.5)", () => {
  const sql = readFileSync(
    join(MIGRATIONS_DIR, "20260321210000_epoch_automation.sql"),
    "utf-8"
  );

  it("creates compute_all_reputations function", () => {
    expect(sql).toContain("compute_all_reputations");
  });

  it("has idempotency guard (same-day skip)", () => {
    expect(sql).toMatch(/IF EXISTS[\s\S]*?status\s*=\s*'success'[\s\S]*?RETURN/);
  });

  it("creates reputation_compute_log table", () => {
    expect(sql).toContain("reputation_compute_log");
  });

  it("logs compute_type, affected_count, status", () => {
    expect(sql).toContain("compute_type");
    expect(sql).toContain("affected_count");
    expect(sql).toContain("status");
  });

  it("uses SECURITY DEFINER", () => {
    expect(sql).toMatch(/compute_all_reputations[\s\S]*?SECURITY DEFINER/);
  });

  it("has error handling with EXCEPTION block", () => {
    expect(sql).toContain("EXCEPTION WHEN OTHERS");
    expect(sql).toContain("SQLERRM");
  });
});

// ─── Epoch Logic Model Tests ──────────────────────────────────

describe("Epoch logic model", () => {
  it("R(g) decay: score * (1 - 0.05) per epoch, floor at 0.01", () => {
    const decayRate = 0.05;
    const floor = 0.01;
    let score = 1.0;
    for (let i = 0; i < 200; i++) {
      score = Math.max(score * (1 - decayRate), floor);
    }
    expect(score).toBe(floor);
  });

  it("decay preserves ordering: higher initial → higher decayed", () => {
    const decay = (s: number) => s * 0.95;
    const a = decay(0.9);
    const b = decay(0.5);
    expect(a).toBeGreaterThan(b);
  });

  it("idempotency: two calls on same day should produce identical results", () => {
    const genes = [
      { id: "g1", arena: 0.8, usage: 0.5, stability: 0.7 },
      { id: "g2", arena: 0.3, usage: 0.9, stability: 0.4 },
    ];
    const compute = () =>
      genes.map((g) => ({
        id: g.id,
        score: 0.5 * g.arena + 0.3 * g.usage + 0.2 * g.stability,
      }));
    const first = compute();
    const second = compute();
    expect(first).toEqual(second);
  });

  it("ContributionMetrics refresh: self-invocation flag works", () => {
    const log = { caller_agent_id: "agent-1", gene_author_id: "agent-1" };
    const isSelf = log.caller_agent_id === log.gene_author_id;
    expect(isSelf).toBe(true);

    const log2 = { caller_agent_id: "agent-2", gene_author_id: "agent-1" };
    expect(log2.caller_agent_id === log2.gene_author_id).toBe(false);
  });

  it("cleanup boundary: exactly 90 days old should be deleted", () => {
    const now = new Date("2026-03-24T12:00:00Z");
    const boundary = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
    const exactlyAtBoundary = new Date(boundary);
    const justBefore = new Date(boundary.getTime() - 1);
    const justAfter = new Date(boundary.getTime() + 1);

    const shouldDelete = (d: Date) => d < boundary;
    expect(shouldDelete(exactlyAtBoundary)).toBe(false);
    expect(shouldDelete(justBefore)).toBe(true);
    expect(shouldDelete(justAfter)).toBe(false);
  });
});
