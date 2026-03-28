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
    expect(output).toContain("--json");
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
