import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(__dirname, "../../dist/index.js");
const TMP = join(tmpdir(), `rotifer-vg-test-${Date.now()}`);

function run(args: string): string {
  try {
    return execSync(`node "${CLI}" ${args} 2>&1`, {
      cwd: TMP,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (e: any) {
    const stdout = e.stdout?.toString() ?? "";
    const stderr = e.stderr?.toString() ?? "";
    return stdout + stderr;
  }
}

function setupFixture(files: Record<string, string>): string {
  const dir = join(TMP, "fixture");
  const srcDir = join(dir, "src");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(srcDir, name), content);
  }
  return dir;
}

const hasCli = existsSync(CLI);

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe.skipIf(!hasCli)("rotifer vg (V(g) security scan)", () => {
  it("shows help text with --help", () => {
    const output = run("vg --help");
    expect(output).toContain("V(g) security scan");
    expect(output).toContain("--all");
    expect(output).toContain("--publish");
    expect(output).toContain("--id");
  });

  it("outputs grade ? for directory without src/", () => {
    const emptyDir = join(TMP, "empty-proj");
    mkdirSync(emptyDir, { recursive: true });
    const output = run(`vg "${emptyDir}"`);
    expect(output).toMatch(/\?|No src/i);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("scans clean code and gives grade A", () => {
    const dir = setupFixture({
      "clean.ts": `export function hello(name: string) { return "Hello " + name; }`,
    });
    const output = run(`vg "${dir}"`);
    expect(output).toContain("A");
  });

  it("detects system command execution (CRITICAL)", () => {
    const dir = setupFixture({
      "danger.ts": `import { exec } from "child_process";\nexec("rm -rf /");`,
    });
    const output = run(`vg "${dir}"`);
    expect(output).toMatch(/CRITICAL|S-02|command/i);
  });

  it("detects eval usage (HIGH severity)", () => {
    const dir = setupFixture({
      "unsafe.ts": `const result = eval("1 + 1");`,
    });
    const output = run(`vg "${dir}"`);
    expect(output).toMatch(/HIGH|eval|dynamic/i);
  });

  it("--json flag produces valid JSON output", () => {
    const dir = setupFixture({
      "simple.ts": `export const x = 42;`,
    });
    const output = run(`vg "${dir}" --json`);
    const result = JSON.parse(output);
    expect(result).toHaveProperty("grade");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("stats");
    expect(result.stats).toHaveProperty("files_scanned");
    expect(result.stats).toHaveProperty("lines_of_code");
  });

  it("--json includes correct skill_id when --id is provided", () => {
    const dir = setupFixture({
      "simple.ts": `export const y = 1;`,
    });
    const output = run(`vg "${dir}" --json --id test-skill-123`);
    const result = JSON.parse(output);
    expect(result.skill_id).toBe("test-skill-123");
  });

  it("--publish without --id shows warning", () => {
    const dir = setupFixture({
      "simple.ts": `export const z = 0;`,
    });
    const output = run(`vg "${dir}" --publish`);
    expect(output).toMatch(/--id|requires/i);
  });

  it("--publish without ROTIFER_BADGE_TOKEN shows warning", () => {
    const dir = setupFixture({
      "simple.ts": `export const z = 0;`,
    });
    const output = run(`vg "${dir}" --publish --id test-gene`);
    expect(output).toMatch(/ROTIFER_BADGE_TOKEN|skipping/i);
  });

  it("counts files and lines correctly", () => {
    const dir = setupFixture({
      "a.ts": "const a = 1;\nconst b = 2;\nconst c = 3;",
      "b.ts": "const d = 4;\nconst e = 5;",
    });
    const output = run(`vg "${dir}" --json`);
    const result = JSON.parse(output);
    expect(result.stats.files_scanned).toBe(2);
    expect(result.stats.lines_of_code).toBeGreaterThanOrEqual(5);
  });

  it("shows disclaimer text in non-JSON output", () => {
    const dir = setupFixture({
      "simple.ts": `export const ok = true;`,
    });
    const output = run(`vg "${dir}"`);
    expect(output).toContain("Static analysis only");
  });
});

// T-88 item 7 and its follow-ups: say what was scanned, and never grade code
// that was not read.
describe.skipIf(!hasCli)("rotifer vg — what it scanned", () => {
  function runWithStatus(args: string): { output: string; status: number } {
    try {
      const output = execSync(`node "${CLI}" ${args} 2>&1`, {
        cwd: TMP,
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { output, status: 0 };
    } catch (e: any) {
      return { output: (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? ""), status: e.status ?? 1 };
    }
  }

  it("reports a path that does not exist instead of grading it ?", () => {
    const { output, status } = runWithStatus("vg no-such-gene");
    expect(output).toContain("No such directory: no-such-gene");
    expect(status).toBe(1);
  });

  it("--all over a directory with nothing to scan says so and gives no grade A", () => {
    const dir = join(TMP, "nothing-to-scan");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "no code here\n");
    const { output } = runWithStatus(`vg "${dir}" --all`);
    expect(output).toContain("No code files found");
    expect(output).not.toMatch(/grade A/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("grades a gene whose index.ts sits at the gene root, as Genesis genes do", () => {
    const dir = join(TMP, "root-index-gene");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), "export function express(x: string) { return x.trim(); }\n");
    writeFileSync(join(dir, "phenotype.json"), "{}");
    const { output } = runWithStatus(`vg "${dir}"`);
    expect(output).toMatch(/Files scanned:\s+1/);
    expect(output).toContain("grade A");
    rmSync(dir, { recursive: true, force: true });
  });

  it("says a Rust gene's code was not scanned instead of finding no code", () => {
    const dir = join(TMP, "rust-gene");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "lib.rs"), "pub fn express() {}\n");
    writeFileSync(join(dir, "phenotype.json"), "{}");
    const { output } = runWithStatus(`vg "${dir}"`);
    expect(output).not.toContain("No code files found");
    expect(output).toContain("Not scanned");
    expect(output).toContain("src/lib.rs");
    rmSync(dir, { recursive: true, force: true });
  });
});
