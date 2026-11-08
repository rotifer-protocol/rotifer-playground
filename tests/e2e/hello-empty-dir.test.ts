/**
 * `rotifer hello --dir` on a directory with none of the template's files.
 *
 * The first gene refuses the empty input. The refusal is correct, but it only
 * names a field, and a non-zero exit is often read through stderr alone, so
 * what to do next has to be there too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(__dirname, "..", "..");
const CLI = join(REPO, "dist", "index.js");

describe("hello --dir with no matching files", () => {
  let project: string;
  let emptyDir: string;

  const hello = (...args: string[]) =>
    spawnSync("node", [CLI, ...args], {
      cwd: project,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "rotifer-hello-empty-dir-"));
    emptyDir = join(project, "nothing-here");
    mkdirSync(emptyDir);
    mkdirSync(join(project, ".rotifer", "agents"), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "t", version: "0.1.0", author: "t", genes_dir: "genes" }),
    );
    for (const gene of ["solidity-parser", "vuln-detector", "audit-reporter"]) {
      cpSync(join(REPO, "genes", gene), join(project, "genes", gene), { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("fails and says on stderr which files to point --dir at", () => {
    const { status, stderr } = hello("hello", "--template", "web3-toolkit", "--dir", emptyDir);
    expect(status).toBe(1);
    expect(stderr).toContain("missing required field 'source'");
    expect(stderr).toContain(`No .sol files in ${emptyDir}`);
    expect(stderr).toContain("--file <path>");
  });

  it("gives an agent the same next step in --json", () => {
    const { status, stdout } = hello("--json", "hello", "--template", "web3-toolkit", "--dir", emptyDir);
    expect(status).toBe(1);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ ok: false, code: "execution_failed", failed_gene: "solidity-parser" });
    expect(report.next_step).toContain(`No .sol files in ${emptyDir}`);
  });

  it("adds no such step when the failure was not an empty scan", () => {
    const { status, stdout } = hello("--json", "hello", "--template", "web3-toolkit", "--input", "{}");
    expect(status).toBe(1);
    expect(JSON.parse(stdout).next_step).toBeUndefined();
  });
});
