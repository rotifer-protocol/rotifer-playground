import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A ClawHub security audit flagged rotifer-gene, rotifer-guide and rotifer-self-evolving-agent
// (2026-09-16) for the same thing: documentation that tells a reader to run `npx @rotifer/<pkg>`
// with no version. An unversioned invocation resolves to whatever the registry serves at that
// moment, so what a user runs is not what was reviewed. The fix was to pin every such command;
// this gate is what keeps them pinned — without it the next edit drifts back silently and the
// next audit finds it instead of us.
//
// mcp-pin-drift.yml answers a different question: whether the agreed pin has fallen behind npm.
// This one answers whether a pin is there at all.

const SKILLS_DIR = join(process.cwd(), "skills");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return entry.endsWith(".md") || entry.endsWith(".json") ? [full] : [];
  });
}

// `npx @rotifer/x`, `npm i -g @rotifer/x`, `npm install @rotifer/x`, or an MCP args entry —
// each must carry an explicit @<version>. The two negative lookaheads matter in that order:
// without `(?![a-z-])` the package name backtracks a character and a pinned `@rotifer/playground@0.26.0`
// reads as an unpinned `@rotifer/playgroun` + `d`, which reports every fixed line as broken. `@<version>` as a literal placeholder is allowed:
// it appears in the "how to move a pin" instructions, which name no version on purpose.
const UNPINNED =
  /(npx(?:\s+(?:-y|--yes))?|npm\s+(?:i|install|exec)(?:\s+-g|\s+--save-dev|\s+--save-exact)*|"args":\s*\[)\s*"?(@rotifer\/[a-z-]+)(?![a-z-])(?!@[0-9<])/g;

describe("published Skills pin the packages they tell you to run", () => {
  const skills = readdirSync(SKILLS_DIR).filter((entry) =>
    statSync(join(SKILLS_DIR, entry)).isDirectory(),
  );

  it("finds the published Skills to check", () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  for (const skill of skills) {
    it(`${skill}: every @rotifer package it tells you to run names a version`, () => {
      const offenders: string[] = [];
      for (const file of markdownFiles(join(SKILLS_DIR, skill))) {
        const text = readFileSync(file, "utf8");
        for (const line of text.split("\n")) {
          UNPINNED.lastIndex = 0;
          // Two ways to satisfy this gate: pin the version, or say on the same line that it is not
          // pinned. The second exists because one path genuinely cannot be pinned here — the MCP
          // server's own `npx -y @rotifer/playground` fallback for `run-agent` lives in the server,
          // not in these files. Describing it is allowed; describing it silently is not.
          if (UNPINNED.test(line) && !/unpinned/i.test(line)) {
            offenders.push(`${file.replace(process.cwd() + "/", "")}: ${line.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
