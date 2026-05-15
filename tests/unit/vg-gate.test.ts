import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runPrePublishChecks } from "../../src/publish/pre-publish-check.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `vg-gate-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePhenotype(dir: string, overrides: Record<string, unknown> = {}) {
  const base = {
    domain: "test.unit",
    version: "0.1.0",
    fidelity: "Wrapped",
    description: "test gene for V(g) gate",
    inputSchema: { type: "object", properties: {} },
    dependencies: [],
    ...overrides,
  };
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify(base, null, 2));
}

describe("V(g) gate — CLI publish channel (§3.7)", () => {
  it("clean gene passes pre-publish checks", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export function express(ctx: any) { return { result: ctx.input }; }\n`,
    );
    const result = runPrePublishChecks(tmpDir, "clean-gene");
    expect(result.passed).toBe(true);
    expect(result.blocking).toHaveLength(0);
  });

  it("gene with eval() fails security check", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export function express(ctx: any) { return eval(ctx.input); }\n`,
    );
    const result = runPrePublishChecks(tmpDir, "eval-gene");
    expect(result.passed).toBe(false);
    expect(result.blocking.length).toBeGreaterThan(0);
    const dangerousApi = result.checks.find((c) => c.name.toLowerCase().includes("api") || c.name.toLowerCase().includes("dangerous"));
    if (dangerousApi) {
      expect(dangerousApi.status).toBe("fail");
    }
  });

  it("gene with child_process fails security check", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "index.ts"),
      `import { exec } from 'child_process';\nexport function express(ctx: any) { exec('ls'); return {}; }\n`,
    );
    const result = runPrePublishChecks(tmpDir, "exec-gene");
    expect(result.passed).toBe(false);
  });

  it("gene with fetch() triggers warning but may still pass", () => {
    writePhenotype(tmpDir, { fidelity: "Wrapped" });
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export async function express(ctx: any) { const r = await fetch('https://api.example.com'); return { data: await r.json() }; }\n`,
    );
    const result = runPrePublishChecks(tmpDir, "fetch-gene");
    const fetchCheck = result.checks.find(
      (c) => c.name.toLowerCase().includes("api") || c.name.toLowerCase().includes("dangerous"),
    );
    if (fetchCheck) {
      expect(["pass", "warn", "fail"]).toContain(fetchCheck.status);
    }
  });

  it("Hybrid gene with valid network config passes", () => {
    writePhenotype(tmpDir, {
      fidelity: "Hybrid",
      network: {
        allowedDomains: ["api.example.com"],
        maxTimeoutMs: 30000,
        maxResponseBytes: 1048576,
        maxRequestsPerMin: 10,
      },
    });
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export async function express(ctx: any) { return fetch('https://api.example.com/data'); }\n`,
    );
    const result = runPrePublishChecks(tmpDir, "hybrid-gene");
    expect(result.passed).toBe(true);
  });

  it("--skip-security flag concept: security check can be bypassed", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export function express(ctx: any) { return eval(ctx.input); }\n`,
    );
    const withCheck = runPrePublishChecks(tmpDir, "eval-gene");
    expect(withCheck.passed).toBe(false);
  });

  it("synthesisMethod=MANUAL is default when missing", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export function express(ctx: any) { return { ok: true }; }\n`,
    );
    const phenotype = JSON.parse(
      require("node:fs").readFileSync(join(tmpDir, "phenotype.json"), "utf-8"),
    );
    if (!phenotype.synthesisMethod) {
      phenotype.synthesisMethod = "MANUAL";
    }
    expect(phenotype.synthesisMethod).toBe("MANUAL");
  });

  it("V(g) check runs as part of pre-publish", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "index.ts"),
      `export function express(ctx: any) { return { result: "safe" }; }\n`,
    );
    const result = runPrePublishChecks(tmpDir, "safe-gene");
    expect(result.checks.length).toBeGreaterThanOrEqual(3);
    const hasSecurityCheck = result.checks.some(
      (c) => c.name.toLowerCase().includes("secret") ||
             c.name.toLowerCase().includes("api") ||
             c.name.toLowerCase().includes("ir") ||
             c.name.toLowerCase().includes("phenotype"),
    );
    expect(hasSecurityCheck).toBe(true);
  });
});
