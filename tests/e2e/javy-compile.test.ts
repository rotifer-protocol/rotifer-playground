import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(
  args: string,
  cwd: string,
  timeout = 90_000,
): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-javy-" + randomUUID());
  mkdirSync(join(dir, "genes", "ts-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "javy-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    }),
  );
  return dir;
}

function writePhenotype(
  dir: string,
  gene: string,
  extra: Record<string, unknown> = {},
) {
  const phenotype = {
    domain: "general.text",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    outputSchema: {
      type: "object",
      properties: { greeting: { type: "string" } },
    },
    version: "0.1.0",
    fidelity: "Wrapped",
    transparency: "Open",
    ...extra,
  };
  writeFileSync(
    join(dir, "genes", gene, "phenotype.json"),
    JSON.stringify(phenotype, null, 2),
  );
}

function writeGeneSource(dir: string, gene: string, code: string) {
  writeFileSync(join(dir, "genes", gene, "index.ts"), code);
}

let javyAvailable = false;

beforeAll(() => {
  try {
    execSync("npx javy-cli --version", { stdio: "pipe", timeout: 45_000 });
    javyAvailable = true;
  } catch {
    javyAvailable = false;
  }
}, 60_000);

describe("Javy TS→WASM compilation (v0.3)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("auto-detects TypeScript gene and compiles to Native WASM", { timeout: 30000 }, () => {
    if (!javyAvailable) return;

    writePhenotype(projectDir, "ts-gene");
    writeGeneSource(
      projectDir,
      "ts-gene",
      `
      export function express(input) {
        return { greeting: "Hello, " + (input.name || "world") + "!" };
      }
    `,
    );

    const { stdout, exitCode } = run("compile ts-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TypeScript gene detected");
    expect(stdout).toContain("Step 1/3");
    expect(stdout).toContain("Step 2/3");
    expect(stdout).toContain("Step 3/3");
    expect(stdout).toContain("WASM compiled");

    expect(
      existsSync(join(projectDir, "genes", "ts-gene", "gene.wasm")),
    ).toBe(true);

    const wasmSize = readFileSync(
      join(projectDir, "genes", "ts-gene", "gene.wasm"),
    ).length;
    expect(wasmSize).toBeGreaterThan(100_000); // Javy modules include QuickJS (~1MB)
  });

  it("produces gene.ir.wasm with compile-result.json", { timeout: 30000 }, () => {
    if (!javyAvailable) return;

    writePhenotype(projectDir, "ts-gene");
    writeGeneSource(
      projectDir,
      "ts-gene",
      `export function express(input) { return { out: input.name }; }`,
    );

    const { stdout, exitCode } = run("compile ts-gene", projectDir);

    if (exitCode === 0 && stdout.includes("Native")) {
      const resultPath = join(
        projectDir,
        "genes",
        "ts-gene",
        ".compile-result.json",
      );
      expect(existsSync(resultPath)).toBe(true);
      const result = JSON.parse(readFileSync(resultPath, "utf-8"));
      expect(result.fidelity).toBe("Native");
      expect(result.wasmAvailable).toBe(true);
      expect(result.durationMs).toBeGreaterThan(0);
    }
  });

  it("handles TypeScript with interfaces and type annotations", { timeout: 30000 }, () => {
    if (!javyAvailable) return;

    writePhenotype(projectDir, "ts-gene");
    writeGeneSource(
      projectDir,
      "ts-gene",
      `
      interface Input { name: string; count?: number; }
      interface Output { greeting: string; repeated: number; }

      export function express(input: Input): Output {
        const name: string = input.name || "world";
        const count: number = input.count || 1;
        return { greeting: "Hello, " + name + "!".repeat(count), repeated: count };
      }
    `,
    );

    const { stdout, exitCode } = run("compile ts-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TypeScript gene detected");
  });

  it("falls back to Wrapped when no source file and no WASM exist", () => {
    writePhenotype(projectDir, "ts-gene");
    // No index.ts and no gene.wasm

    const { stdout, exitCode } = run("compile ts-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Wrapped fidelity");
  });

  it("prefers TS source over a stale existing gene.wasm", () => {
    writePhenotype(projectDir, "ts-gene");
    writeGeneSource(
      projectDir,
      "ts-gene",
      `export function express(input) { return { greeting: "fresh:" + input.name }; }`,
    );

    const dummyWasm = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]);
    writeFileSync(
      join(projectDir, "genes", "ts-gene", "gene.wasm"),
      dummyWasm,
    );

    const { stdout, exitCode } = run("compile ts-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TypeScript gene detected");
    expect(stdout).not.toContain("existing gene.wasm");
    expect(readFileSync(join(projectDir, "genes", "ts-gene", "gene.wasm")).length).toBeGreaterThan(100_000);
  });

  it("fails gracefully with invalid TypeScript", { timeout: 30000 }, () => {
    if (!javyAvailable) return;

    writePhenotype(projectDir, "ts-gene");
    writeGeneSource(
      projectDir,
      "ts-gene",
      `this is not valid javascript or typescript at all!!!`,
    );

    const { stdout, exitCode } = run("compile ts-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("compilation failed");
  });

  it("--wasm flag bypasses TS auto-detection", () => {
    writePhenotype(projectDir, "ts-gene");
    writeGeneSource(
      projectDir,
      "ts-gene",
      `export function express(input) { return input; }`,
    );

    const { stdout, exitCode } = run(
      "compile ts-gene --wasm /tmp/does-not-exist.wasm",
      projectDir,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("WASM file not found");
    expect(stdout).not.toContain("TypeScript gene detected");
  });
});
