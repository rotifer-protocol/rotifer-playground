import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CLI = "node dist/index.js";

function cliErr(args: string): string {
  try {
    execSync(`${CLI} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    return "";
  } catch (err: any) {
    return (err.stderr || "") + (err.stdout || "");
  }
}

const PREFIX = "_test_hybrid_pub_";
const createdGenes: string[] = [];

function writePhenotype(name: string, phenotype: Record<string, unknown>): string {
  const dir = join(ROOT, "genes", name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify(phenotype, null, 2) + "\n");
  createdGenes.push(name);
  return dir;
}

function cleanup(...names: string[]) {
  for (const name of names) {
    const dir = join(ROOT, "genes", name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  cleanup(...createdGenes);
  createdGenes.length = 0;
});

describe("Hybrid Publish Validation", () => {
  it("E0055: Hybrid without allowedDomains → publish rejects", () => {
    const name = `${PREFIX}no-domains`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Hybrid",
      version: "0.1.0",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).toMatch(/E0055|allowed[Dd]omain|missing allowedDomains/);
  });

  it("E0055: Hybrid with empty allowedDomains array → publish rejects", () => {
    const name = `${PREFIX}empty-domains`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Hybrid",
      version: "0.1.0",
      network: { allowedDomains: [], maxTimeoutMs: 30000, maxResponseBytes: 1048576, maxRequestsPerMin: 10 },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).toMatch(/E0055|allowed[Dd]omain|missing allowedDomains/);
  });

  it("E0056: Hybrid with localhost → publish rejects", () => {
    const name = `${PREFIX}localhost`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Hybrid",
      version: "0.1.0",
      network: { allowedDomains: ["localhost"], maxTimeoutMs: 30000, maxResponseBytes: 1048576, maxRequestsPerMin: 10 },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).toMatch(/E0056|localhost/);
  });

  it("E0056: Hybrid with 192.168.x.x → publish rejects", () => {
    const name = `${PREFIX}private-ip`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Hybrid",
      version: "0.1.0",
      network: { allowedDomains: ["192.168.1.100"], maxTimeoutMs: 30000, maxResponseBytes: 1048576, maxRequestsPerMin: 10 },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).toMatch(/E0056|192\.168/);
  });

  it("E0056: Hybrid with 127.0.0.1 → publish rejects", () => {
    const name = `${PREFIX}loopback`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Hybrid",
      version: "0.1.0",
      network: { allowedDomains: ["127.0.0.1"], maxTimeoutMs: 30000, maxResponseBytes: 1048576, maxRequestsPerMin: 10 },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).toMatch(/E0056|127\.0\.0\.1/);
  });

  it("Hybrid with valid domain passes validation (fails at auth, not domain check)", () => {
    const name = `${PREFIX}valid`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Hybrid",
      version: "0.1.0",
      network: { allowedDomains: ["api.openai.com"], maxTimeoutMs: 30000, maxResponseBytes: 1048576, maxRequestsPerMin: 10 },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).not.toMatch(/E0055/);
    expect(out).not.toMatch(/E0056/);
    expect(out).not.toMatch(/missing allowedDomains/);
  });

  it("Native gene skips Hybrid validation entirely", () => {
    const name = `${PREFIX}native`;
    writePhenotype(name, {
      domain: "test",
      fidelity: "Native",
      version: "0.1.0",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
    });
    const out = cliErr(`publish ${name}`);
    expect(out).not.toMatch(/E0055/);
    expect(out).not.toMatch(/E0056/);
  });
});
