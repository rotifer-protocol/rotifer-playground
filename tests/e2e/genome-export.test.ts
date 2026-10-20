import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { hasNativeGeneIdV2 } from "../../src/utils/binding.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const TEST_DIR = join(tmpdir(), `rotifer-genome-e2e-${randomUUID()}`);
const WS = join(TEST_DIR, "ws");

// Obviously fake, assembled at run time: the shape of a 32-byte private key in hex.
const FAKE_HEX_KEY = "deadbeef".repeat(8);

function run(args: string[], cwd = WS): { out: string; stdout: string; exitCode: number } {
  try {
    const out = execFileSync("node", [CLI, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, HOME: TEST_DIR, FORCE_COLOR: "0", ROTIFER_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, stdout: out, exitCode: 0 };
  } catch (err: any) {
    return { out: (err.stdout || "") + (err.stderr || ""), stdout: err.stdout || "", exitCode: err.status ?? 1 };
  }
}

describe("rotifer genome export (real CLI)", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    expect(run(["init", "ws"], TEST_DIR).exitCode).toBe(0);
  }, 60_000);

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("genome export --help lists its options", () => {
    const r = run(["genome", "export", "--help"]);
    expect(r.exitCode).toBe(0);
    for (const opt of ["--output", "--lock", "--min-fitness", "--min-vg", "--description"]) {
      expect(r.out).toContain(opt);
    }
  });

  it("an unknown agent exits 1", () => {
    const r = run(["genome", "export", "no-such-agent"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("Agent 'no-such-agent' not found");
  });

  // Computing a v2 ID needs a native addon that exports `geneIdV2`.
  describe.skipIf(!hasNativeGeneIdV2())("with the native addon", () => {
    beforeAll(() => {
      const r = run(["agent", "create", "demo", "-g", "genesis-file-read", "hello-world", "--composition", "Seq"]);
      expect(r.exitCode).toBe(0);
    });

    it("exports a Seq agent to a Blueprint with real v2 IDs and exit 0", () => {
      const r = run(["genome", "export", "demo", "-o", "demo.rgenome"]);
      expect(r.exitCode).toBe(0);
      const bp = JSON.parse(readFileSync(join(WS, "demo.rgenome"), "utf-8"));
      expect(bp.snapshot.genes.map((g: { role: string }) => g.role)).toEqual(["genesis-file-read", "hello-world"]);
      for (const g of bp.snapshot.genes) expect(g.geneId).toMatch(/^v2:[0-9a-f]{64}$/);
      expect(Object.keys(bp.snapshot.composition)).toEqual(["Seq"]);
    });

    it("a bare hex private key planted in the description aborts with nonzero exit and is not echoed", () => {
      const r = run(["genome", "export", "demo", "-o", "leak.rgenome", "-d", `seed ${FAKE_HEX_KEY}`]);
      expect(r.exitCode).not.toBe(0);
      expect(r.out).toContain("/metadata/description");
      expect(r.out).not.toContain(FAKE_HEX_KEY);
      expect(existsSync(join(WS, "leak.rgenome"))).toBe(false);
    });

    it("--json reports the finding by position", () => {
      const r = run(["--json", "genome", "export", "demo", "-o", "leak2.rgenome", "-d", FAKE_HEX_KEY]);
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.findings[0]).toMatchObject({ pointer: "/metadata/description", layer: "value-pattern" });
      expect(r.out).not.toContain(FAKE_HEX_KEY);
    });

    it("a TryPool agent is refused", () => {
      expect(
        run(["agent", "create", "pool", "-g", "genesis-file-read", "hello-world", "--composition", "TryPool"]).exitCode,
      ).toBe(0);
      const r = run(["genome", "export", "pool", "-o", "pool.rgenome"]);
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain("Composition 'TryPool' cannot be exported");
    });
  });
});
