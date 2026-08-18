// Rotifer Protocol plugin for OpenClaw.
//
// Hand-authored, not generated: the sync pipeline owns the manifests in this
// folder, and this file is the plugin entry point they point at.
//
// It only enumerates what is on disk — it reads each SKILL.md's frontmatter and
// reports it. No network calls, no commands, no writes. The MCP server this
// plugin provides is declared in openclaw.plugin.json, not started here.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(HERE, "skills");

/** Parse the small subset of YAML frontmatter a SKILL.md actually uses. */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const meta = {};
  let key = null;
  let folded = [];

  for (const line of match[1].split("\n")) {
    const start = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (start && !line.startsWith(" ")) {
      if (key) meta[key] = folded.join(" ").trim();
      key = start[1];
      folded = [">-", ">", "|"].includes(start[2]) ? [] : [start[2]];
    } else if (key && line.trim()) {
      folded.push(line.trim());
    }
  }
  if (key) meta[key] = folded.join(" ").trim();

  for (const k of Object.keys(meta)) {
    meta[k] = meta[k].replace(/^["']|["']$/g, "");
  }
  return meta;
}

function readSkill(path, fallbackName) {
  try {
    const meta = parseFrontmatter(readFileSync(path, "utf-8"));
    return {
      name: meta.name || fallbackName,
      description: meta.description || "",
      version: meta.version || null,
      path,
    };
  } catch (error) {
    console.error(`[rotifer] could not read ${fallbackName}: ${error.message}`);
    return null;
  }
}

/**
 * Every Skill this plugin ships.
 *
 * Two shapes live side by side under skills/: a folder with a SKILL.md, and a
 * bare .md file. Both are real — skills/rotifer.md is one of the latter — so
 * missing either would under-report what the plugin provides.
 */
export function getSkills() {
  if (!existsSync(skillsDir)) return [];

  const skills = [];
  for (const entry of readdirSync(skillsDir)) {
    const full = join(skillsDir, entry);
    if (statSync(full).isDirectory()) {
      const file = join(full, "SKILL.md");
      if (existsSync(file)) skills.push(readSkill(file, entry));
    } else if (extname(entry) === ".md") {
      skills.push(readSkill(full, basename(entry, ".md")));
    }
  }
  return skills.filter(Boolean);
}

export default { getSkills };
