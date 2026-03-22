import { Command } from "commander";
import { resolve } from "node:path";
import chalk from "chalk";
import { scan } from "../scanner/index.js";
import * as display from "../utils/display.js";
import type { Finding, ScanResult } from "../scanner/types.js";

const BADGE_WORKER_URL = "https://badge.rotifer.dev";

const GRADE_COLORS: Record<string, (s: string) => string> = {
  A: chalk.green,
  B: chalk.greenBright,
  C: chalk.yellow,
  D: chalk.red,
  "?": chalk.gray,
};

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  CRITICAL: chalk.red.bold,
  HIGH: chalk.yellow,
  MEDIUM: chalk.dim,
};

function printFinding(f: Finding): void {
  const sev = SEVERITY_COLORS[f.severity]?.(f.severity) ?? f.severity;
  const loc = chalk.dim(`${f.file}:${f.line}`);
  console.log(`  ${sev} [${f.rule}] ${loc}`);
  console.log(`    ${chalk.dim(f.snippet)}`);
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
  .description("V(g) security scan — static analysis for Skill/Gene code safety")
  .argument("[path]", "path to Skill or Gene directory", ".")
  .option("--id <skill_id>", "skill/gene identifier for the report")
  .option("--json", "output raw JSON report")
  .option("--all", "scan all code files, not just src/")
  .option("--publish", "publish safety grade to badge.rotifer.dev (requires ROTIFER_BADGE_TOKEN)")
  .action(async (pathArg: string, opts: { id?: string; json?: boolean; all?: boolean; publish?: boolean }) => {
    const dir = resolve(pathArg);
    const result = scan(dir, opts.id, { scanAll: opts.all });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (opts.publish && result.grade !== "?" && opts.id) {
        await publishSafety(opts.id, result, "0.8.0");
      }
      return;
    }

    display.header("V(g) Security Scan");

    if (result.grade === "?") {
      display.info(`No src/ directory found — grade: ${chalk.gray("?")}`);
      display.info("Pure-prompt Skills without code receive grade \"?\".");
      return;
    }

    const gradeColor = GRADE_COLORS[result.grade] ?? chalk.white;
    display.keyValue("Skill", result.skill_id);
    display.keyValue("Files scanned", String(result.stats.files_scanned));
    display.keyValue("Lines of code", String(result.stats.lines_of_code));
    display.keyValue("Grade", gradeColor(result.grade));

    if (result.findings.length === 0) {
      console.log();
      display.success("No security findings — grade A");
    } else {
      console.log();
      const criticals = result.findings.filter((f) => f.severity === "CRITICAL");
      const highs = result.findings.filter((f) => f.severity === "HIGH");
      const mediums = result.findings.filter((f) => f.severity === "MEDIUM");

      if (criticals.length > 0) {
        console.log(chalk.red.bold(`  CRITICAL (${criticals.length}):`));
        criticals.forEach(printFinding);
      }
      if (highs.length > 0) {
        console.log(chalk.yellow(`  HIGH (${highs.length}):`));
        highs.forEach(printFinding);
      }
      if (mediums.length > 0) {
        console.log(chalk.dim(`  MEDIUM (${mediums.length}):`));
        mediums.forEach(printFinding);
      }
    }

    if (opts.publish) {
      if (!opts.id) {
        display.warn("--publish requires --id <gene_uuid> to identify the gene");
      } else {
        console.log();
        await publishSafety(opts.id, result, "0.8.0");
      }
    }

    console.log();
    console.log(
      chalk.dim("  Disclaimer: Static analysis only. Not a substitute for"),
    );
    console.log(
      chalk.dim("  manual review or runtime sandboxing. See https://rotifer.ai/badge.html"),
    );
  });
