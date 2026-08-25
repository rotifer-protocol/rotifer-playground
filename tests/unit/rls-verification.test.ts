/**
 * Gap #3: RLS runtime verification
 *
 * Every table created by the migrations must (1) have RLS enabled and
 * (2) match a DECLARED access mode. The old version of this suite demanded a
 * SELECT + INSERT policy on every table, which is wrong for two legitimate
 * security models this schema actually uses: deny-all (rate_limit_buckets —
 * zero policies, service role only) and public-read (audit/read-model tables
 * that clients must never write). It also searched only the migration file
 * that created the table, so policies added by later migrations were
 * invisible; all checks now run against the concatenation of every migration.
 *
 * A new table fails until its access mode is declared in EXPECTED_ACCESS —
 * that declaration, next to the migration in the same PR, is the review
 * surface this guard exists to create.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../supabase/migrations");
const RAG_MIGRATIONS_DIR = join(import.meta.dirname, "../../../rotifer-dev/supabase/migrations");
const HAS_RAG_DIR = existsSync(RAG_MIGRATIONS_DIR);

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

/**
 * Replays CREATE POLICY / DROP POLICY across the migrations in order and
 * returns the policies that survive. A plain "does the text mention a policy"
 * scan is wrong here: 20260210_reputation.sql created WITH CHECK (true)
 * insert policies that 20260228_security_hardening.sql dropped and replaced
 * with WITH CHECK (false) — only the final state is the schema's truth.
 */
interface LivePolicy {
  table: string;
  action: string; // SELECT | INSERT | UPDATE | DELETE | ALL
  body: string; // full statement tail, holds USING / WITH CHECK expressions
}

function replayPolicies(orderedSqls: string[]): Map<string, LivePolicy> {
  const live = new Map<string, LivePolicy>();
  const createRe =
    /CREATE POLICY\s+(?:"([^"]+)"|(\w+))\s+ON\s+(\w+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)([\s\S]*?);/gi;
  const dropRe = /DROP POLICY(?:\s+IF EXISTS)?\s+(?:"([^"]+)"|(\w+))\s+ON\s+(\w+)/gi;
  for (const sql of orderedSqls) {
    // Within one migration, statements execute top-to-bottom; interleave both
    // kinds by their position in the file.
    const events: Array<{ idx: number; run: () => void }> = [];
    for (const m of sql.matchAll(createRe)) {
      const [, quoted, bare, table, action, body] = m;
      const name = quoted ?? bare;
      events.push({
        idx: m.index ?? 0,
        run: () => live.set(`${table}:${name}`, { table, action: action.toUpperCase(), body }),
      });
    }
    for (const m of sql.matchAll(dropRe)) {
      const [, quoted, bare, table] = m;
      const name = quoted ?? bare;
      events.push({ idx: m.index ?? 0, run: () => live.delete(`${table}:${name}`) });
    }
    events.sort((a, b) => a.idx - b.idx).forEach((e) => e.run());
  }
  return live;
}

function policiesFor(live: Map<string, LivePolicy>, table: string, action: string): LivePolicy[] {
  return [...live.values()].filter((p) => p.table === table && (p.action === action || p.action === "ALL"));
}

function isDenyBody(body: string): boolean {
  // Explicit deny forms: USING (false) / WITH CHECK (false)
  return /(?:USING|WITH CHECK)\s*\(\s*false\s*\)/i.test(body) && !/\(\s*true\s*\)/i.test(body);
}

type AccessMode =
  | "public-read" // clients may SELECT; writes denied (no INSERT policy, or explicit WITH CHECK (false))
  | "read-write" // clients may SELECT and INSERT under policy conditions
  | "deny-all"; // RLS on, zero policies — service role only

/**
 * The declared security model, table by table. Adding a table to the schema
 * without adding it here fails the suite on purpose.
 */
const EXPECTED_ACCESS: Record<string, AccessMode> = {
  gene_reputation: "public-read",
  developer_reputation: "public-read",
  doc_chunks: "public-read",
  reputation_compute_log: "public-read",
  gene_invocation_log: "public-read",
  gene_contribution_metrics: "public-read",
  seasons: "public-read",
  season_archives: "public-read",
  gene_artifact_scan: "public-read",
  gene_visibility_log: "public-read",
  arena_evaluation_runs: "read-write",
  rate_limit_buckets: "deny-all",
};

/** Pure check core, returns human-readable violations (empty = compliant). */
function checkTableAccess(
  allSql: string,
  live: Map<string, LivePolicy>,
  table: string,
  mode: AccessMode,
): string[] {
  const violations: string[] = [];
  if (!hasRLS(allSql, table)) {
    violations.push(`${table}: RLS is not enabled`);
  }
  const selects = policiesFor(live, table, "SELECT").filter((p) => !isDenyBody(p.body));
  const permissiveInserts = policiesFor(live, table, "INSERT").filter((p) => !isDenyBody(p.body));
  if (mode === "deny-all") {
    if (selects.length > 0) {
      violations.push(`${table}: declared deny-all but a readable SELECT policy exists — update EXPECTED_ACCESS if this is intended`);
    }
    if (permissiveInserts.length > 0) {
      violations.push(`${table}: declared deny-all but a permissive INSERT policy exists — update EXPECTED_ACCESS if this is intended`);
    }
    return violations;
  }
  if (selects.length === 0) {
    violations.push(`${table}: declared ${mode} but has no readable SELECT policy`);
  }
  if (mode === "public-read" && permissiveInserts.length > 0) {
    violations.push(`${table}: declared public-read but a permissive INSERT policy exists — clients can write`);
  }
  if (mode === "read-write" && permissiveInserts.length === 0) {
    violations.push(`${table}: declared read-write but has no permissive INSERT policy`);
  }
  return violations;
}

// ─── Playground Migrations ────────────────────────────────────

describe("RLS: playground migrations", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const orderedSqls = files.map((f) => readMigration(MIGRATIONS_DIR, f));
  const allSql = orderedSqls.join("\n");
  const live = replayPolicies(orderedSqls);
  const tables = [...new Set(orderedSqls.flatMap((sql) => extractTables(sql)))];

  it("all migration files are readable", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every table declares an expected access mode", () => {
    const undeclared = tables.filter((t) => !(t in EXPECTED_ACCESS));
    expect(
      undeclared,
      `New table(s) without a declared access mode: ${JSON.stringify(undeclared)}. ` +
        "Add each to EXPECTED_ACCESS in this file, stating the intended security model.",
    ).toEqual([]);
  });

  it("no stale entries linger in EXPECTED_ACCESS", () => {
    const stale = Object.keys(EXPECTED_ACCESS).filter((t) => !tables.includes(t));
    expect(stale, `Declared but absent from migrations: ${JSON.stringify(stale)}`).toEqual([]);
  });

  for (const [table, mode] of Object.entries(EXPECTED_ACCESS)) {
    it(`${table} complies with its declared mode (${mode})`, () => {
      expect(checkTableAccess(allSql, live, table, mode)).toEqual([]);
    });
  }
});

// ─── Check-core self-tests (fixtures that express each failure) ──

describe("RLS: checkTableAccess self-tests", () => {
  const fixture = (body: string) => `
    CREATE TABLE IF NOT EXISTS t1 (id int);
    ${body}
  `;
  const check = (sql: string, mode: AccessMode) => checkTableAccess(sql, replayPolicies([sql]), "t1", mode);

  it("passes a compliant public-read table (explicit insert deny)", () => {
    const sql = fixture(`
      ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p1 ON t1 FOR SELECT USING (true);
      CREATE POLICY p2 ON t1 FOR INSERT WITH CHECK (false);
    `);
    expect(check(sql, "public-read")).toEqual([]);
  });

  it("passes a compliant public-read table (no insert policy at all)", () => {
    const sql = fixture(`
      ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p1 ON t1 FOR SELECT USING (true);
    `);
    expect(check(sql, "public-read")).toEqual([]);
  });

  it("passes a compliant deny-all table and a compliant read-write table", () => {
    const denyAll = fixture(`ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;`);
    expect(check(denyAll, "deny-all")).toEqual([]);
    const rw = fixture(`
      ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p1 ON t1 FOR SELECT USING (true);
      CREATE POLICY p2 ON t1 FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
    `);
    expect(check(rw, "read-write")).toEqual([]);
  });

  it("flags missing RLS", () => {
    const sql = fixture(`CREATE POLICY p1 ON t1 FOR SELECT USING (true);`);
    expect(check(sql, "public-read")).toContainEqual(expect.stringContaining("RLS is not enabled"));
  });

  it("flags a permissive INSERT on a public-read table", () => {
    const sql = fixture(`
      ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p1 ON t1 FOR SELECT USING (true);
      CREATE POLICY p2 ON t1 FOR INSERT WITH CHECK (true);
    `);
    expect(check(sql, "public-read")).toContainEqual(expect.stringContaining("permissive INSERT"));
  });

  it("flags policies on a deny-all table and a read-write table without insert", () => {
    const leaky = fixture(`
      ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p1 ON t1 FOR SELECT USING (true);
    `);
    expect(check(leaky, "deny-all")).toContainEqual(
      expect.stringContaining("declared deny-all but a readable SELECT policy exists"),
    );
    expect(check(leaky, "read-write")).toContainEqual(
      expect.stringContaining("no permissive INSERT policy"),
    );
  });

  it("a dropped-then-hardened policy counts by its FINAL state (the 20260228 scenario)", () => {
    const early = `
      CREATE TABLE IF NOT EXISTS t1 (id int);
      ALTER TABLE t1 ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "readable" ON t1 FOR SELECT USING (true);
      CREATE POLICY "writable" ON t1 FOR INSERT WITH CHECK (true);
    `;
    const hardening = `
      DROP POLICY IF EXISTS "writable" ON t1;
      CREATE POLICY "locked" ON t1 FOR INSERT WITH CHECK (false);
    `;
    const live = replayPolicies([early, hardening]);
    expect(checkTableAccess(early + hardening, live, "t1", "public-read")).toEqual([]);
    // And the reverse order would be a live permissive policy — prove the
    // replay actually orders, rather than just unioning text.
    const liveReversed = replayPolicies([hardening, early]);
    expect(checkTableAccess(early + hardening, liveReversed, "t1", "public-read")).toContainEqual(
      expect.stringContaining("permissive INSERT"),
    );
  });
});

// ─── RAG Migrations ───────────────────────────────────────────

describe.skipIf(!HAS_RAG_DIR)("RLS: RAG migrations", () => {
  const sql = HAS_RAG_DIR ? readMigration(RAG_MIGRATIONS_DIR, "20260322200000_rag_schema.sql") : "";

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
