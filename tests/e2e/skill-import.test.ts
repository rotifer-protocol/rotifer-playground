import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `rotifer-skill-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(
  args: string,
  opts: { cwd?: string } = {}
): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd || TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR },
      timeout: 15_000,
      encoding: "utf-8",
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

const VALID_SKILL = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill with valid frontmatter.
`;

const SKILL_NO_NAME = `---
description: Missing name field
---

# Broken Skill
`;

const SKILL_NO_FRONTMATTER = `# Just Markdown

No YAML frontmatter here.
`;

describe("Skill Import: scan --skills", () => {
  const skillsDir = join(TEST_DIR, "skills");

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      join(TEST_DIR, "rotifer.json"),
      JSON.stringify({
        name: "skill-test",
        version: "0.1.0",
        author: "test-runner",
        genes_dir: "genes",
        default_domain: "general",
      })
    );
    mkdirSync(join(TEST_DIR, "genes"), { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("scan --skills --help shows skill scanning options", () => {
    const result = run("scan --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--skills");
    expect(result.stdout).toContain("--skills-path");
  });

  it("scan --skills with no SKILL.md files shows warning", () => {
    const emptyDir = join(TEST_DIR, "empty-skills");
    mkdirSync(emptyDir, { recursive: true });
    const result = run(`scan --skills --skills-path empty-skills`);
    expect(result.stdout).toContain("No SKILL.md");
  });

  it("scan --skills discovers valid SKILL.md files", () => {
    mkdirSync(join(skillsDir, "skill-a"), { recursive: true });
    writeFileSync(join(skillsDir, "skill-a", "SKILL.md"), VALID_SKILL);

    mkdirSync(join(skillsDir, "skill-b"), { recursive: true });
    writeFileSync(
      join(skillsDir, "skill-b", "SKILL.md"),
      `---\nname: another-skill\ndescription: Second test skill\n---\n# Another\n`
    );

    const result = run(`scan --skills --skills-path skills`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test-skill");
    expect(result.stdout).toContain("another-skill");
    expect(result.stdout).toContain("Found 2 skill");
  });

  it("scan --skills skips SKILL.md without valid name", () => {
    const noNameDir = join(TEST_DIR, "no-name-skills", "broken");
    mkdirSync(noNameDir, { recursive: true });
    writeFileSync(join(noNameDir, "SKILL.md"), SKILL_NO_NAME);

    const result = run(`scan --skills --skills-path no-name-skills`);
    expect(result.stdout).toContain("No SKILL.md");
  });

  it("scan --skills skips files without YAML frontmatter", () => {
    const noFmDir = join(TEST_DIR, "no-fm-skills", "plain");
    mkdirSync(noFmDir, { recursive: true });
    writeFileSync(join(noFmDir, "SKILL.md"), SKILL_NO_FRONTMATTER);

    const result = run(`scan --skills --skills-path no-fm-skills`);
    expect(result.stdout).toContain("No SKILL.md");
  });

  it("scan --skills shows wrap hint in output", () => {
    const result = run(`scan --skills --skills-path skills`);
    expect(result.stdout).toContain("rotifer wrap");
    expect(result.stdout).toContain("--from-skill");
  });

  it("scan without --skills flag does normal function scan", () => {
    const srcDir = join(TEST_DIR, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "example.ts"),
      'export function helloWorld() { return "hi"; }\n'
    );
    const result = run("scan src");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("helloWorld");
    expect(result.stdout).not.toContain("SKILL.md");
  });
});

describe("Skill Import: wrap --from-skill", () => {
  const projectDir = join(tmpdir(), `rotifer-wrap-skill-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, "genes"), { recursive: true });
    mkdirSync(join(projectDir, "skills", "my-skill"), { recursive: true });
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({
        name: "wrap-skill-test",
        version: "0.1.0",
        author: "test-runner",
        genes_dir: "genes",
        default_domain: "general",
      })
    );
    writeFileSync(
      join(projectDir, "skills", "my-skill", "SKILL.md"),
      VALID_SKILL
    );
  });

  afterAll(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("wrap --from-skill --help shows from-skill option", () => {
    const result = run("wrap --help", { cwd: projectDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--from-skill");
  });

  it("wrap --from-skill creates gene directory with phenotype", () => {
    const result = run(
      "wrap imported-skill --from-skill skills/my-skill/SKILL.md --domain ai-tools",
      { cwd: projectDir }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wrapped as gene");

    const geneDir = join(projectDir, "genes", "imported-skill");
    expect(existsSync(geneDir)).toBe(true);
    expect(existsSync(join(geneDir, "phenotype.json"))).toBe(true);
    expect(existsSync(join(geneDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(geneDir, ".gene-manifest.json"))).toBe(true);
  });

  it("phenotype.json has correct fields from SKILL.md", () => {
    const phenotype = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "imported-skill", "phenotype.json"),
        "utf-8"
      )
    );
    expect(phenotype.domain).toBe("ai-tools");
    expect(phenotype.description).toContain("test skill");
    expect(phenotype.fidelity).toBe("Wrapped");
    expect(phenotype.source).toBe("skill");
    expect(phenotype.version).toBe("0.1.0");
    expect(phenotype.inputSchema).toBeDefined();
    expect(phenotype.outputSchema).toBeDefined();
  });

  it("SKILL.md is copied into gene directory", () => {
    const copied = readFileSync(
      join(projectDir, "genes", "imported-skill", "SKILL.md"),
      "utf-8"
    );
    expect(copied).toContain("test-skill");
    expect(copied).toContain("A test skill for unit testing");
  });

  it(".gene-manifest.json records skill source", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "imported-skill", ".gene-manifest.json"),
        "utf-8"
      )
    );
    expect(manifest.name).toBe("imported-skill");
    expect(manifest.domain).toBe("ai-tools");
    expect(manifest.fromSkill).toBeDefined();
    expect(manifest.wrappedAt).toBeDefined();
    expect(manifest.geneId).toHaveLength(64);
  });

  it("wrap --from-skill with directory path (auto-appends SKILL.md)", () => {
    const result = run(
      "wrap dir-imported --from-skill skills/my-skill --domain general",
      { cwd: projectDir }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wrapped as gene");
    expect(
      existsSync(join(projectDir, "genes", "dir-imported", "phenotype.json"))
    ).toBe(true);
  });

  it("wrap --from-skill fails with nonexistent path", () => {
    const result = run(
      "wrap bad-skill --from-skill nonexistent/SKILL.md",
      { cwd: projectDir }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("not found");
  });

  it("wrap --from-skill fails with invalid SKILL.md (no name)", () => {
    writeFileSync(
      join(projectDir, "skills", "broken-skill.md"),
      SKILL_NO_NAME
    );
    mkdirSync(join(projectDir, "skills", "broken"), { recursive: true });
    writeFileSync(
      join(projectDir, "skills", "broken", "SKILL.md"),
      SKILL_NO_NAME
    );
    const result = run(
      "wrap bad-name --from-skill skills/broken/SKILL.md",
      { cwd: projectDir }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Invalid SKILL.md");
  });

  it("default domain is 'general' when --domain not specified", () => {
    const result = run(
      "wrap default-domain-skill --from-skill skills/my-skill/SKILL.md",
      { cwd: projectDir }
    );
    expect(result.exitCode).toBe(0);
    const phenotype = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "default-domain-skill", "phenotype.json"),
        "utf-8"
      )
    );
    expect(phenotype.domain).toBe("general");
  });
});

describe("Skill Import: parseSkillFrontmatter unit tests", () => {
  it("parses valid YAML frontmatter", async () => {
    const { parseSkillFrontmatter } = await import("../../src/commands/scan.js");
    const result = parseSkillFrontmatter(VALID_SKILL);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test-skill");
    expect(result!.description).toBe("A test skill for unit testing");
  });

  it("returns null for missing frontmatter", async () => {
    const { parseSkillFrontmatter } = await import("../../src/commands/scan.js");
    const result = parseSkillFrontmatter(SKILL_NO_FRONTMATTER);
    expect(result).toBeNull();
  });

  it("returns null when name is missing", async () => {
    const { parseSkillFrontmatter } = await import("../../src/commands/scan.js");
    const result = parseSkillFrontmatter(SKILL_NO_NAME);
    expect(result).toBeNull();
  });

  it("handles quoted values in frontmatter", async () => {
    const { parseSkillFrontmatter } = await import("../../src/commands/scan.js");
    const content = `---\nname: "quoted-name"\ndescription: 'single quoted desc'\n---\n`;
    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("quoted-name");
    expect(result!.description).toBe("single quoted desc");
  });

  it("handles name without description", async () => {
    const { parseSkillFrontmatter } = await import("../../src/commands/scan.js");
    const content = `---\nname: name-only\n---\n# Just name`;
    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("name-only");
    expect(result!.description).toBe("");
  });
});
