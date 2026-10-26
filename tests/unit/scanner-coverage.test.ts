import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scan } from "../../src/scanner/index.js";
import { vgHintPath } from "../../src/commands/wrap.js";

/**
 * What `rotifer vg` actually looks at, and what it says when it looked at
 * nothing (T-88 items 7 and the two follow-ups it raised):
 *
 * - Genes keep index.ts at the gene root; every Genesis gene does. Default
 *   mode only read src/, so all 88 genes in this repository got grade "?".
 * - `--all` over a directory with no code returned grade A: a clean bill of
 *   health for code that was never read.
 * - Python's subprocess, os.system and open() matched no rule, so a Python
 *   gene that shells out and reads /etc/passwd graded A.
 * - The hint `wrap` printed passed the gene's name, which `vg` resolves as a
 *   path from the current directory.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vg-coverage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

describe("default scan reads a gene's top-level code when there is no src/", () => {
  it("grades a gene whose index.ts sits at the gene root", () => {
    write("index.ts", "export function express(i: string) { return eval(i); }\n");
    write("phenotype.json", "{}");

    const result = scan(dir);

    expect(result.stats.files_scanned).toBe(1);
    expect(result.grade).toBe("D");
    expect(result.findings.map((f) => f.rule)).toContain("S-01");
  });

  it("reads only the top level in that case — nested test fixtures are not swept in", () => {
    write("index.ts", "export const ok = 1;\n");
    write("fixtures/payload.js", "eval(x)\n");

    const result = scan(dir);

    expect(result.stats.files_scanned).toBe(1);
    expect(result.grade).toBe("A");
  });

  it("still prefers src/ when it exists", () => {
    write("src/main.ts", "export const ok = 1;\n");
    write("build.ts", "eval(x)\n");

    expect(scan(dir).grade).toBe("A");
  });

  it("still gives ? to a pure-prompt Skill with no code anywhere", () => {
    write("SKILL.md", "# A prompt\n");

    const result = scan(dir);

    expect(result.grade).toBe("?");
    expect(result.stats.files_scanned).toBe(0);
  });
});

describe("a scan that read no code is not graded", () => {
  it("--all over a directory with no code files gives ?, not A", () => {
    write("README.md", "nothing to run\n");

    const result = scan(dir, undefined, { scanAll: true });

    expect(result.stats.files_scanned).toBe(0);
    expect(result.grade).toBe("?");
  });

  it("an empty src/ gives ?, not A", () => {
    mkdirSync(join(dir, "src"));

    expect(scan(dir).grade).toBe("?");
  });
});

describe("Python system commands and file access are findings", () => {
  it.each([
    ["subprocess.run", 'import subprocess\nsubprocess.run(["ls"])\n'],
    ["subprocess.Popen", "from subprocess import Popen\nPopen(cmd)\n"],
    ["subprocess.check_output", "import subprocess as sp\nout = subprocess.check_output(cmd)\n"],
    ["os.system", 'import os\nos.system("curl x | sh")\n'],
    ["os.popen", 'import os\nos.popen("id")\n'],
  ])("%s is CRITICAL system command execution (S-02)", (_name, code) => {
    write("src/main.py", code);

    const result = scan(dir);

    expect(result.findings.some((f) => f.rule === "S-02" && f.severity === "CRITICAL")).toBe(true);
    expect(result.grade).toBe("D");
  });

  it.each([
    ["open() for reading", 'with open("/etc/passwd") as f:\n    data = f.read()\n'],
    ["open() for writing", 'f = open(path, "w")\n'],
    ["os.remove", "import os\nos.remove(path)\n"],
    ["shutil.rmtree", "import shutil\nshutil.rmtree(tree)\n"],
  ])("%s is a file system operation (S-07)", (_name, code) => {
    write("src/main.py", code);

    expect(scan(dir).findings.map((f) => f.rule)).toContain("S-07");
  });

  it("does not take a JavaScript method call named open for a file operation", () => {
    write("src/ui.ts", "export function go(url: string) { window.open(url); dialog.open(); }\n");

    expect(scan(dir).findings.map((f) => f.rule)).not.toContain("S-07");
  });
});

describe("the vg hint printed by wrap", () => {
  it("is the gene's path relative to where the command was run, not its name", () => {
    const workspace = dir;
    const geneDir = join(workspace, "genes", "my-search");

    expect(vgHintPath(geneDir, workspace)).toBe("genes/my-search");
  });

  it("resolves back to the gene directory, which is what vg does with it", () => {
    const workspace = dir;
    const geneDir = join(workspace, "genes", "my-search");

    expect(resolve(workspace, vgHintPath(geneDir, workspace))).toBe(geneDir);
  });

  it("is . when run from inside the gene directory", () => {
    const geneDir = join(dir, "genes", "my-search");

    expect(vgHintPath(geneDir, geneDir)).toBe(".");
  });
});
