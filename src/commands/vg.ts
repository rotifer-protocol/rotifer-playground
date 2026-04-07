import { Command } from "commander";
import { resolve, relative, basename } from "node:path";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { scan } from "../scanner/index.js";
import type { Finding, ScanResult } from "../scanner/types.js";

const BADGE_WORKER_URL = "https://badge.rotifer.dev";

const GRADE_COLORS: Record<string, (s: string) => string> = {
  A: c.success,
  B: c.accentBright,
  C: c.warn,
  D: c.error,
  "?": c.muted,
};

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  CRITICAL: c.error.bold,
  HIGH: c.warn,
  MEDIUM: c.muted,
};

function printFinding(f: Finding): void {
  const sev = SEVERITY_COLORS[f.severity]?.(f.severity) ?? f.severity;
  const loc = c.muted(`${f.file}:${f.line}`);
  console.log(`  ${sev} [${f.rule}] ${loc}`);
  console.log(`    ${c.muted(f.snippet)}`);
}

async function publishSafety(
  geneId: string,
  result: ScanResult,
  scannerVersion: string,
): Promise<void> {
  const token = process.env.ROTIFER_BADGE_TOKEN;
  if (!token) {
    display.warn("ROTIFER_BADGE_TOKEN not set — skipping publish");
    return;
  }

  const body = {
    gene_id: geneId,
    grade: result.grade,
    scanner_version: scannerVersion,
    findings_count: result.findings.length,
  };

  try {
    const res = await fetch(`${BADGE_WORKER_URL}/safety/${geneId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      display.success(`Safety grade ${result.grade} published to badge.rotifer.dev (self-reported)`);
    } else {
      const err = await res.text();
      display.warn(`Failed to publish safety grade: ${res.status} ${err}`);
    }
  } catch (e) {
    display.warn(`Failed to publish safety grade: ${(e as Error).message}`);
  }
}

export const vgCommand = new Command("vg")
  .description("V(g) security scan for gene code safety")
  .argument("[path]", "path to Skill or Gene directory", ".")
  .option("--id <skill_id>", "skill/gene identifier for the report")
  .option("--all", "scan all code files, not just src/")
  .option("--publish", "publish safety grade to badge.rotifer.dev (requires ROTIFER_BADGE_TOKEN)")
  .action(async (pathArg: string, opts: { id?: string; all?: boolean; publish?: boolean }) => {
    const dir = resolve(pathArg);
    const result = scan(dir, opts.id, { scanAll: opts.all });

    if (opts.publish && display.isJsonMode() && result.grade !== "?" && opts.id) {
      await publishSafety(opts.id, result, "0.8.0");
    }

    display.renderResult(result, (data) => {
      display.header("V(g) Security Scan");

      if (data.grade === "?") {
        display.info(`No src/ directory found — grade: ${c.muted("?")}`);
        display.hint("Pure-prompt Skills without code receive grade \"?\".");
        return;
      }

      const gradeColor = GRADE_COLORS[data.grade] ?? c.accent;
      const rel = relative(process.cwd(), data.skill_id);
      const displayPath = rel === "" ? basename(data.skill_id) : (rel.startsWith("..") ? data.skill_id : `./${rel}`);
      display.kv("Path", displayPath);
      display.kv("Files scanned", String(data.stats.files_scanned));
      display.kv("Lines of code", String(data.stats.lines_of_code));
      display.kv("Grade", gradeColor(data.grade));

      if (data.findings.length === 0) {
        console.log();
        display.success("No security findings — grade A");
      } else {
        const criticals = data.findings.filter((f: Finding) => f.severity === "CRITICAL");
        const highs = data.findings.filter((f: Finding) => f.severity === "HIGH");
        const mediums = data.findings.filter((f: Finding) => f.severity === "MEDIUM");

        const parts = [
          criticals.length > 0 ? c.error.bold(`CRITICAL: ${criticals.length}`) : `CRITICAL: 0`,
          highs.length > 0 ? c.warn(`HIGH: ${highs.length}`) : `HIGH: 0`,
          mediums.length > 0 ? c.muted(`MEDIUM: ${mediums.length}`) : `MEDIUM: 0`,
        ];
        display.kv("Findings", parts.join("  "));
        console.log();

        if (criticals.length > 0) {
          console.log(c.error.bold(`  CRITICAL (${criticals.length}):`));
          criticals.forEach(printFinding);
        }
        if (highs.length > 0) {
          console.log(c.warn(`  HIGH (${highs.length}):`));
          highs.forEach(printFinding);
        }
        if (mediums.length > 0) {
          console.log(c.muted(`  MEDIUM (${mediums.length}):`));
          mediums.forEach(printFinding);
        }
      }

      if (opts.publish) {
        if (!opts.id) {
          display.warn("--publish requires --id <gene_uuid> to identify the gene");
        } else {
          console.log();
          publishSafety(opts.id, result, "0.8.0");
        }
      }

      console.log();
      display.hint("Disclaimer: Static analysis only. Not a substitute for");
      display.hint("manual review or runtime sandboxing. See https://rotifer.ai/badge.html");
    });
  });
