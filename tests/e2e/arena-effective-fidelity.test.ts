/**
 * `arena submit` discounts by the tier the Gene earned on this run (T-95),
 * end to end through the built CLI.
 *
 * A Gene that declares Native but has no compiled artifact ran nothing: its
 * score comes off the content hash. It used to take the Native ×1.00 anyway.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";
import { FIDELITY_DISCOUNT } from "../../src/types/phenotype.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const NOT_RUN_NOTE = "Declared Native, not run in the sandbox this time (counted as Wrapped)";

function run(args: string, cwd: string, home: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 60000,
      env: { ...process.env, HOME: home, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe.runIf(existsSync(CLI))("arena submit discounts by the tier that actually ran", () => {
  let projectDir: string;
  let home: string;

  const writeGene = (name: string, fidelity: string) => {
    mkdirSync(join(projectDir, "genes", name), { recursive: true });
    writeFileSync(
      join(projectDir, "genes", name, "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
        outputSchema: { type: "object", properties: { greeting: { type: "string" } } },
        version: "0.1.0",
        fidelity,
      }, null, 2),
    );
  };
  const cache = (name: string) =>
    JSON.parse(readFileSync(join(projectDir, "genes", name, ".arena-cache.json"), "utf-8"));

  beforeEach(() => {
    projectDir = join(tmpdir(), "rotifer-effective-fidelity-" + randomUUID());
    home = join(projectDir, ".home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(projectDir, "genes"), { recursive: true });
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "fx", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("a declared Native with no compiled artifact takes the Wrapped discount and says so", () => {
    writeGene("native-uncompiled", "Native");
    const { stdout, exitCode } = run("arena submit native-uncompiled", projectDir, home);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain(NOT_RUN_NOTE);
    expect(stdout).toContain("wrapped discount");

    const c = cache("native-uncompiled");
    expect(c.fidelity_discount).toBe(FIDELITY_DISCOUNT.wrapped);
    expect(c.fitness).toBeCloseTo(c.base_fitness * FIDELITY_DISCOUNT.wrapped, 12);
    expect(c.declared_fidelity).toBe("Native");
    expect(c.effective_fidelity).toBe("Wrapped");
  });

  it("Wrapped and Hybrid are scored as declared, with no note", () => {
    writeGene("wrapped-gene", "Wrapped");
    writeGene("hybrid-gene", "Hybrid");
    for (const [name, tier, discount] of [
      ["wrapped-gene", "Wrapped", FIDELITY_DISCOUNT.wrapped],
      ["hybrid-gene", "Hybrid", FIDELITY_DISCOUNT.hybrid],
    ] as const) {
      const { stdout, exitCode } = run(`arena submit ${name}`, projectDir, home);
      expect(exitCode, stdout).toBe(0);
      expect(stdout).not.toContain(NOT_RUN_NOTE);
      const c = cache(name);
      expect(c.fidelity_discount).toBe(discount);
      expect(c.declared_fidelity).toBe(tier);
      expect(c.effective_fidelity).toBe(tier);
    }
  });

  // Needs the TS→WASM toolchain and the napi sandbox; skipped where either is
  // missing, so a run without them reads as skipped rather than passed.
  it.skipIf(!hasJavyToolchain || !hasSandbox)("a declared Native that ran in the sandbox keeps the Native discount", () => {
    const src = join(__dirname, "..", "..", "genes", "genesis-code-format");
    const dest = join(projectDir, "genes", "genesis-code-format");
    execSync(`cp -R "${src}" "${dest}"`);
    const compiled = run("compile genesis-code-format", projectDir, process.env.HOME ?? home);
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    expect(existsSync(join(dest, "gene.ir.wasm"))).toBe(true);

    const { stdout, exitCode } = run("arena submit genesis-code-format", projectDir, home);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("Sandbox verified");
    expect(stdout).not.toContain(NOT_RUN_NOTE);
    const c = cache("genesis-code-format");
    expect(c.fidelity_discount).toBe(FIDELITY_DISCOUNT.native);
    expect(c.effective_fidelity).toBe("Native");
  }, 120_000);

  // --cloud against a stand-in for the cloud API: what the CLI sends, and
  // what it says when the server answers. Spawned, not execSync'd: the stub
  // lives in this process and has to keep answering while the CLI runs.
  const CLOUD_GENE_ID = "e71a0000-0000-4000-8000-00000000000a";
  type Stub = { url: string; posts: Record<string, unknown>[]; close: () => Promise<void> };
  async function startCloudStub(answer: "accept" | "refuse-old-guard"): Promise<Stub> {
    const posts: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && req.url?.startsWith("/rest/v1/genes")) {
          res.end(JSON.stringify([{
            id: CLOUD_GENE_ID, name: "native-uncompiled", domain: "general", version: "0.1.0",
            fidelity: "Native", owner_id: "e7111111-1111-4111-8111-111111111111",
            profiles: { username: "eff_a" }, phenotype: {}, published: true,
          }]));
        } else if (req.method === "POST" && req.url?.startsWith("/rest/v1/arena_entries")) {
          const row = JSON.parse(body);
          posts.push(row);
          if (answer === "accept") {
            res.statusCode = 201;
            res.end(JSON.stringify([{ ...row, total_calls: 0, effective_fidelity: "Wrapped" }]));
          } else {
            // What the guard before 20261027100000 answers.
            res.statusCode = 403;
            res.end(JSON.stringify({
              code: "42501",
              message: `arena_entries: fidelity_discount ${row.fidelity_discount} does not match the gene's fidelity Native (spec §5.1: 1)`,
            }));
          }
        } else {
          res.end("[]");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, posts, close: () => new Promise((r) => server.close(() => r())) };
  }

  function runAsync(args: string[], env: Record<string, string>): Promise<{ stdout: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: projectDir,
        env: { ...process.env, HOME: home, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0", DO_NOT_TRACK: "1", ...env },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("exit", (code) => resolve({ stdout: out, exitCode: code }));
    });
  }

  /** A signed-in user with the gene published, inside the test's own HOME. */
  function signInAndPublish(): void {
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({ access_token: "test-token-not-real", expires_at: Date.now() + 3_600_000 }),
    );
    writeFileSync(
      join(projectDir, "genes", "native-uncompiled", ".cloud-manifest.json"),
      JSON.stringify({ cloud_id: CLOUD_GENE_ID }),
    );
  }

  it("--cloud sends a Native score that ran nothing at the Wrapped discount", async () => {
    writeGene("native-uncompiled", "Native");
    signInAndPublish();
    const stub = await startCloudStub("accept");
    try {
      const { stdout, exitCode } = await runAsync(["arena", "submit", "native-uncompiled", "--cloud"], {
        ROTIFER_CLOUD_ENDPOINT: stub.url, ROTIFER_CLOUD_ANON_KEY: "anon-test-key",
      });
      expect(exitCode, stdout).toBe(0);
      expect(stub.posts, stdout).toHaveLength(1);
      const sent = stub.posts[0] as { fidelity_discount: number; base_fitness: number; fitness_value: number; evaluation_n?: number };
      expect(sent.fidelity_discount).toBe(FIDELITY_DISCOUNT.wrapped);
      expect(sent.fitness_value).toBeCloseTo(sent.base_fitness * FIDELITY_DISCOUNT.wrapped, 12);
      // The tier is the server's reading of the discount, not a field the client sends.
      expect(sent).not.toHaveProperty("effective_fidelity");
      expect(sent.evaluation_n).toBeUndefined();
      expect(stdout).toContain("Submitted to cloud Arena");
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("--cloud against a cloud Arena that still refuses a lower tier says so, and what to do", async () => {
    writeGene("native-uncompiled", "Native");
    signInAndPublish();
    const stub = await startCloudStub("refuse-old-guard");
    try {
      const { stdout } = await runAsync(["arena", "submit", "native-uncompiled", "--cloud"], {
        ROTIFER_CLOUD_ENDPOINT: stub.url, ROTIFER_CLOUD_ANON_KEY: "anon-test-key",
      });
      expect(stub.posts, stdout).toHaveLength(1);
      expect(stdout).toContain("does not accept a score below the declared tier yet");
      expect(stdout).toContain("rotifer compile native-uncompiled");
      expect(stdout).not.toContain("Check your network connection");
    } finally {
      await stub.close();
    }
  }, 60_000);
});
