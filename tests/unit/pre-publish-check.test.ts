import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runPrePublishChecks } from "../../src/publish/pre-publish-check.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `prepub-test-${randomUUID()}`);
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
    description: "Unit test gene",
    inputSchema: { type: "object", properties: {} },
    dependencies: [],
    ...overrides,
  };
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify(base, null, 2));
}

describe("runPrePublishChecks", () => {
  it("passes for a clean gene with valid phenotype", () => {
    writePhenotype(tmpDir);
    const result = runPrePublishChecks(tmpDir, "clean-gene");
    expect(result.passed).toBe(true);
    expect(result.blocking).toHaveLength(0);
    expect(result.checks.length).toBeGreaterThanOrEqual(4);
  });

  it("fails when gene contains eval() (V(g) grade D)", () => {
    writePhenotype(tmpDir);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), 'const x = eval("1+1");\n');

    const result = runPrePublishChecks(tmpDir, "eval-gene");
    expect(result.passed).toBe(false);
    expect(result.grade).toBe("D");
    const vgCheck = result.checks.find((c) => c.name === "V(g) Security Scan");
    expect(vgCheck?.status).toBe("fail");
    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
  });

  it("warns but passes for grade C (>2 HIGH findings)", () => {
    writePhenotype(tmpDir);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "risky.ts"),
      [
        'await fetch("https://a.com");',
        "const k = process.env.KEY;",
        'const ws = new WebSocket("wss://b.com");',
      ].join("\n") + "\n",
    );

    const result = runPrePublishChecks(tmpDir, "risky-gene");
    expect(result.passed).toBe(true);
    expect(result.grade).toBe("C");
    const vgCheck = result.checks.find((c) => c.name === "V(g) Security Scan");
    expect(vgCheck?.status).toBe("warn");
  });

  it("fails when WASM binary has invalid magic bytes", () => {
    writePhenotype(tmpDir, { fidelity: "Native" });
    writeFileSync(join(tmpDir, "gene.ir.wasm"), Buffer.from("not-wasm-content"));

    const result = runPrePublishChecks(tmpDir, "bad-wasm-gene");
    expect(result.passed).toBe(false);
    const irCheck = result.checks.find((c) => c.name === "IR WASM Integrity");
    expect(irCheck?.status).toBe("fail");
    expect(irCheck?.message).toContain("magic bytes");
  });

  it("fails when WASM binary is empty", () => {
    writePhenotype(tmpDir, { fidelity: "Native" });
    writeFileSync(join(tmpDir, "gene.ir.wasm"), Buffer.alloc(0));

    const result = runPrePublishChecks(tmpDir, "empty-wasm-gene");
    expect(result.passed).toBe(false);
    const irCheck = result.checks.find((c) => c.name === "IR WASM Integrity");
    expect(irCheck?.status).toBe("fail");
    expect(irCheck?.message).toContain("empty");
  });

  it("passes IR check when WASM has valid magic bytes", () => {
    writePhenotype(tmpDir, { fidelity: "Native" });
    const validWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    writeFileSync(join(tmpDir, "gene.ir.wasm"), validWasm);

    const result = runPrePublishChecks(tmpDir, "valid-wasm-gene");
    const irCheck = result.checks.find((c) => c.name === "IR WASM Integrity");
    expect(irCheck?.status).toBe("pass");
  });

  it("passes IR check when no WASM file (non-Native gene)", () => {
    writePhenotype(tmpDir, { fidelity: "Wrapped" });

    const result = runPrePublishChecks(tmpDir, "wrapped-gene");
    const irCheck = result.checks.find((c) => c.name === "IR WASM Integrity");
    expect(irCheck?.status).toBe("pass");
    expect(irCheck?.message).toContain("non-Native");
  });

  it("fails when phenotype.json is missing", () => {
    const result = runPrePublishChecks(tmpDir, "no-phenotype-gene");
    expect(result.passed).toBe(false);
    const schemaCheck = result.checks.find((c) => c.name === "Phenotype Schema");
    expect(schemaCheck?.status).toBe("fail");
    expect(schemaCheck?.message).toContain("Missing phenotype.json");
  });

  it("fails when phenotype.json contains invalid JSON", () => {
    writeFileSync(join(tmpDir, "phenotype.json"), "{ invalid json }");

    const result = runPrePublishChecks(tmpDir, "bad-json-gene");
    expect(result.passed).toBe(false);
    const schemaCheck = result.checks.find((c) => c.name === "Phenotype Schema");
    expect(schemaCheck?.status).toBe("fail");
    expect(schemaCheck?.message).toContain("Invalid JSON");
  });

  it("warns when phenotype.json is missing recommended fields", () => {
    writeFileSync(join(tmpDir, "phenotype.json"), JSON.stringify({ domain: "test" }));

    const result = runPrePublishChecks(tmpDir, "sparse-gene");
    const schemaCheck = result.checks.find((c) => c.name === "Phenotype Schema");
    expect(schemaCheck?.status).toBe("warn");
    expect(schemaCheck?.message).toContain("Missing recommended fields");
  });

  it("fails when phenotype has invalid fidelity value", () => {
    writePhenotype(tmpDir, { fidelity: "SuperNative" });

    const result = runPrePublishChecks(tmpDir, "bad-fidelity-gene");
    expect(result.passed).toBe(false);
    const schemaCheck = result.checks.find((c) => c.name === "Phenotype Schema");
    expect(schemaCheck?.status).toBe("fail");
    expect(schemaCheck?.message).toContain("Invalid fidelity");
  });

  it("detects hardcoded AWS key in gene files", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ aws_key: "AKIAIOSFODNN7EXAMPLE" }),
    );

    const result = runPrePublishChecks(tmpDir, "aws-leak-gene");
    expect(result.passed).toBe(false);
    const secretCheck = result.checks.find((c) => c.name === "Sensitive Data Scan");
    expect(secretCheck?.status).toBe("fail");
    expect(secretCheck?.message).toContain("AWS key");
  });

  it("detects hardcoded GitHub token", () => {
    writePhenotype(tmpDir);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "auth.ts"),
      'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n',
    );

    const result = runPrePublishChecks(tmpDir, "ghp-leak-gene");
    expect(result.passed).toBe(false);
    const secretCheck = result.checks.find((c) => c.name === "Sensitive Data Scan");
    expect(secretCheck?.status).toBe("fail");
    expect(secretCheck?.message).toContain("GitHub token");
  });

  it("detects private key block", () => {
    writePhenotype(tmpDir);
    writeFileSync(
      join(tmpDir, "key.ts"),
      'const pk = `-----BEGIN RSA PRIVATE KEY-----\nMIIE...`;\n',
    );

    const result = runPrePublishChecks(tmpDir, "pk-leak-gene");
    expect(result.passed).toBe(false);
    const secretCheck = result.checks.find((c) => c.name === "Sensitive Data Scan");
    expect(secretCheck?.status).toBe("fail");
    expect(secretCheck?.message).toContain("Private key");
  });

  it("passes sensitive data check when gene is clean", () => {
    writePhenotype(tmpDir);
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), 'export const hello = "world";\n');

    const result = runPrePublishChecks(tmpDir, "clean-src-gene");
    const secretCheck = result.checks.find((c) => c.name === "Sensitive Data Scan");
    expect(secretCheck?.status).toBe("pass");
  });

  it("warns when package.json has file: references", () => {
    writePhenotype(tmpDir, { dependencies: ["other-gene"] });
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "local-pkg": "file:../local-pkg" } }),
    );

    const result = runPrePublishChecks(tmpDir, "local-dep-gene");
    const depCheck = result.checks.find((c) => c.name === "Dependency Audit");
    expect(depCheck?.status).toBe("warn");
    expect(depCheck?.message).toContain("local reference");
  });

  it("runs all 5 checks", () => {
    writePhenotype(tmpDir);
    const result = runPrePublishChecks(tmpDir, "full-check-gene");
    expect(result.checks).toHaveLength(5);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("V(g) Security Scan");
    expect(names).toContain("IR WASM Integrity");
    expect(names).toContain("Phenotype Schema");
    expect(names).toContain("Sensitive Data Scan");
    expect(names).toContain("Dependency Audit");
  });

  it("multiple failures are all reported", () => {
    writeFileSync(join(tmpDir, "phenotype.json"), "not json");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "bad.ts"), 'eval("hack");\n');
    writeFileSync(join(tmpDir, "gene.ir.wasm"), Buffer.alloc(0));

    const result = runPrePublishChecks(tmpDir, "multi-fail-gene");
    expect(result.passed).toBe(false);
    expect(result.blocking.length).toBeGreaterThanOrEqual(2);
  });
});
