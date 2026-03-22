import { Command } from "commander";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot } from "../utils/config.js";

interface Candidate {
  name: string;
  filePath: string;
  lineNumber: number;
  language: string;
}

/** Skill candidate from SKILL.md (YAML frontmatter: name, description) */
export interface SkillCandidate {
  name: string;
  description: string;
  filePath: string;
}

const SKILL_FILENAME = "SKILL.md";

export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const front = match[1];
  const nameMatch = front.match(/name:\s*["']?([^"'\n]+)["']?/);
  const descMatch = front.match(/description:\s*["']?([^"'\n]+(?:[^"']*)?)["']?/);
  const name = nameMatch ? nameMatch[1].trim() : "";
  const description = descMatch ? descMatch[1].trim() : "";
  return name ? { name, description } : null;
}

function scanDirectoryForSkills(dir: string, baseDir: string): SkillCandidate[] {
  const results: SkillCandidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
      results.push(...scanDirectoryForSkills(full, baseDir));
    } else if (stat.isFile() && entry === SKILL_FILENAME) {
      const content = readFileSync(full, "utf-8");
      const parsed = parseSkillFrontmatter(content);
      if (parsed) {
        results.push({
          name: parsed.name,
          description: parsed.description,
          filePath: full,
        });
      }
    }
  }
  return results;
}

export const scanCommand = new Command("scan")
  .description("Scan source files for candidate gene functions, or local skills (SKILL.md)")
  .argument("[path]", "path to scan", ".")
  .option("--skills", "scan for SKILL.md files instead of source functions")
  .option("--skills-path <dir>", "when using --skills, directory to scan (default: [path] or .cursor/skills)")
  .action(async (scanPath: string, options: { skills?: boolean; skillsPath?: string }) => {
    const root = getProjectRoot();
    const fullPath = options.skills && options.skillsPath
      ? join(root, options.skillsPath)
      : join(root, scanPath);

    if (options.skills) {
      display.header("Skill Scanner (SKILL.md → Gene candidates)");
      display.info("Scanning for " + SKILL_FILENAME + ": " + fullPath);
      const skillCandidates = scanDirectoryForSkills(fullPath, fullPath);
      if (skillCandidates.length === 0) {
        display.warn("No " + SKILL_FILENAME + " files found");
        display.info("Example: rotifer scan --skills --skills-path .cursor/skills");
        return;
      }
      display.success("Found " + skillCandidates.length + " skill(s):");
      console.log();
      for (const s of skillCandidates) {
        const desc = s.description.slice(0, 50) + (s.description.length > 50 ? "…" : "");
        console.log("  " + s.name + "  " + s.filePath);
        console.log("      " + desc);
      }
      console.log();
      display.info("Wrap and upload: rotifer wrap <name> --from-skill <path> --domain <domain>");
      display.info("  then: rotifer compile <name> && rotifer publish <name>");
      return;
    }

    display.header("Gene Candidate Scanner");
    display.info("Scanning: " + fullPath);

    const candidates = scanDirectory(fullPath);

    if (candidates.length === 0) {
      display.warn("No candidate functions found");
      display.info("Candidates: exported functions (export function / pub fn)");
      return;
    }

    display.success("Found " + candidates.length + " candidate function(s):");
    console.log();
    for (const c of candidates) {
      const lang = c.language === "typescript" ? "TS" : "RS";
      console.log("  " + lang + "  " + c.name + "  " + c.filePath + ":" + c.lineNumber);
    }
    console.log();
    display.info("Use 'rotifer wrap <name> --domain <domain>' to create a gene");
  });

function scanDirectory(dir: string): Candidate[] {
  const results: Candidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
      results.push(...scanDirectory(full));
    } else if (stat.isFile() && [".ts", ".js", ".rs"].includes(extname(entry))) {
      results.push(...scanFile(full));
    }
  }
  return results;
}

function scanFile(filePath: string): Candidate[] {
  const results: Candidate[] = [];
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const isTs = filePath.endsWith(".ts") || filePath.endsWith(".js");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (isTs) {
      const m = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (m) results.push({ name: m[1], filePath, lineNumber: i + 1, language: "typescript" });
    } else if (filePath.endsWith(".rs")) {
      const m = line.match(/^pub\s+(?:async\s+)?fn\s+(\w+)/);
      if (m) results.push({ name: m[1], filePath, lineNumber: i + 1, language: "rust" });
    }
  }
  return results;
}
