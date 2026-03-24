/**
 * Gap #3: RLS runtime verification
 * Verifies all migration files have proper RLS policies
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../supabase/migrations");
const RAG_MIGRATIONS_DIR = join(import.meta.dirname, "../../../rotifer-dev/supabase/migrations");

function readMigration(dir: string, filename: string): string {
  return readFileSync(join(dir, filename), "utf-8");
}

function extractTables(sql: string): string[] {
  const matches = sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g);
  return [...matches].map((m) => m[1]);
}

function hasRLS(sql: string, table: string): boolean {
  return sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
}

function hasSelectPolicy(sql: string, table: string): boolean {
  return new RegExp(`ON ${table}\\s+FOR SELECT`, "i").test(sql);
}

function hasInsertPolicy(sql: string, table: string): boolean {
  return new RegExp(`ON ${table}\\s+FOR INSERT`, "i").test(sql);
}

// ─── Playground Migrations ────────────────────────────────────

describe("RLS: playground migrations", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  it("all migration files are readable", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const sql = readMigration(MIGRATIONS_DIR, file);
    const tables = extractTables(sql);

    for (const table of tables) {
      it(`${file}: ${table} has RLS enabled`, () => {
        expect(hasRLS(sql, table)).toBe(true);
      });

      it(`${file}: ${table} has SELECT policy`, () => {
        expect(hasSelectPolicy(sql, table)).toBe(true);
      });

      it(`${file}: ${table} has INSERT policy`, () => {
        expect(hasInsertPolicy(sql, table)).toBe(true);
      });
    }
  }
});

// ─── RAG Migrations ───────────────────────────────────────────

describe("RLS: RAG migrations", () => {
  const sql = readMigration(RAG_MIGRATIONS_DIR, "20260322200000_rag_schema.sql");

  it("doc_chunks has RLS enabled", () => {
    expect(hasRLS(sql, "doc_chunks")).toBe(true);
  });

  it("doc_chunks is publicly readable", () => {
    expect(sql).toContain("Doc chunks publicly readable");
    expect(sql).toMatch(/ON doc_chunks\s+FOR SELECT\s+USING \(true\)/);
  });

  it("doc_chunks blocks user writes", () => {
    expect(sql).toMatch(/ON doc_chunks\s+FOR INSERT\s+WITH CHECK \(false\)/);
  });

  it("doc_chunks blocks user deletes", () => {
    expect(sql).toMatch(/ON doc_chunks\s+FOR DELETE\s+USING \(false\)/);
  });

  it("chat_analytics is NOT readable by users", () => {
    expect(sql).toMatch(/ON chat_analytics\s+FOR SELECT\s+USING \(false\)/);
  });

  it("chat_analytics blocks user writes", () => {
    expect(sql).toMatch(/ON chat_analytics\s+FOR INSERT\s+WITH CHECK \(false\)/);
  });

  it("match_documents is SECURITY DEFINER", () => {
    expect(sql).toMatch(/match_documents[\s\S]*?SECURITY DEFINER/);
  });

  it("cleanup_chat_analytics revokes from PUBLIC", () => {
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION cleanup_chat_analytics()");
  });
});

// ─── SECURITY DEFINER Audit ───────────────────────────────────

describe("RLS: privileged SECURITY DEFINER functions have REVOKE", () => {
  const allSql = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readMigration(MIGRATIONS_DIR, f))
    .join("\n");

  const privilegedFunctions = [
    "compute_all_reputations",
    "refresh_contribution_metrics",
    "log_gene_invocation",
    "cleanup_old_invocation_logs",
    "compute_gene_reputation",
    "compute_developer_reputation",
  ];

  const presentFunctions = privilegedFunctions.filter((fn) =>
    allSql.includes(`FUNCTION ${fn}`)
  );

  it("at least 3 privileged functions are identified", () => {
    expect(presentFunctions.length).toBeGreaterThanOrEqual(3);
  });

  for (const fn of presentFunctions) {
    it(`${fn} has REVOKE from PUBLIC`, () => {
      expect(allSql).toContain(`REVOKE EXECUTE ON FUNCTION ${fn}`);
    });
  }
});
