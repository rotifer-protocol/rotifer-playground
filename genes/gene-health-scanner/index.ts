import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface HealthInput {
  genesDir?: string;
  verbose?: boolean;
}

interface DimensionResult {
  name: string;
  score: number;
  findings: string[];
  suggestions: string[];
}

interface HealthOutput {
  summary: string;
  dimensions: DimensionResult[];
  overallScore: number;
  geneCount: number;
  recommendations: string[];
}

interface Phenotype {
  name?: string;
  version?: string;
  domain?: string;
  fidelity?: string;
  description?: string;
  author?: string;
  tags?: string[];
  dependencies?: string[];
  inputSchema?: { properties?: Record<string, unknown> };
  outputSchema?: { properties?: Record<string, unknown> };
}

interface RunLogEntry {
  success: boolean;
  durationMs: number;
}

function loadPhenotypes(genesDir: string): Map<string, Phenotype> {
  const result = new Map<string, Phenotype>();
  if (!existsSync(genesDir)) return result;

  for (const entry of readdirSync(genesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const phenoPath = join(genesDir, entry.name, "phenotype.json");
    if (!existsSync(phenoPath)) continue;
    try {
      const raw = readFileSync(phenoPath, "utf-8");
      result.set(entry.name, JSON.parse(raw) as Phenotype);
    } catch {
      result.set(entry.name, {});
    }
  }
  return result;
}

function hasImplementation(genesDir: string, geneName: string): boolean {
  return (
    existsSync(join(genesDir, geneName, "index.ts")) ||
    existsSync(join(genesDir, geneName, "index.js"))
  );
}

function readImplementation(genesDir: string, geneName: string): string | null {
  for (const file of ["index.ts", "index.js"]) {
    const p = join(genesDir, geneName, file);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    }
  }
  return null;
}

function analyzeCapabilityDistribution(phenotypes: Map<string, Phenotype>): DimensionResult {
  const domainCounts = new Map<string, number>();
  const findings: string[] = [];
  const suggestions: string[] = [];

  for (const [, pheno] of phenotypes) {
    const domain = pheno.domain ?? "unknown";
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }

  const total = phenotypes.size;
  const domainCount = domainCounts.size;
  findings.push(`${total} genes across ${domainCount} domains`);

  let maxRatio = 0;
  let dominantDomain = "";
  for (const [domain, count] of domainCounts) {
    const ratio = total > 0 ? count / total : 0;
    findings.push(`${domain}: ${count} genes (${(ratio * 100).toFixed(1)}%)`);
    if (ratio > maxRatio) {
      maxRatio = ratio;
      dominantDomain = domain;
    }
  }

  let score = 1.0;
  if (maxRatio > 0.6) {
    score = Math.max(0, 1.0 - (maxRatio - 0.6) * 2.5);
    suggestions.push(
      `Domain "${dominantDomain}" holds ${(maxRatio * 100).toFixed(1)}% of genes — capability imbalance (偏科). Diversify into underrepresented domains.`
    );
  }
  if (domainCount < 3 && total > 5) {
    score = Math.min(score, 0.5);
    suggestions.push("Fewer than 3 domains detected. Consider expanding capability coverage.");
  }

  return { name: "Capability Distribution", score, findings, suggestions };
}

function analyzeProtocolCompliance(genesDir: string, phenotypes: Map<string, Phenotype>): DimensionResult {
  const findings: string[] = [];
  const suggestions: string[] = [];
  let totalScore = 0;

  for (const [name, pheno] of phenotypes) {
    let geneScore = 0;
    const missing: string[] = [];

    if (pheno.description) geneScore += 0.1;
    else missing.push("description");

    if (pheno.inputSchema?.properties && Object.keys(pheno.inputSchema.properties).length > 0) geneScore += 0.15;
    else missing.push("inputSchema.properties");

    if (pheno.outputSchema?.properties && Object.keys(pheno.outputSchema.properties).length > 0) geneScore += 0.15;
    else missing.push("outputSchema.properties");

    if (pheno.tags && pheno.tags.length > 0) geneScore += 0.1;
    else missing.push("tags");

    if (pheno.author) geneScore += 0.05;
    else missing.push("author");

    if (pheno.version) geneScore += 0.05;
    else missing.push("version");

    if (pheno.fidelity === "Native" && !hasImplementation(genesDir, name)) {
      findings.push(`${name}: declares Native fidelity but has no index.ts/index.js`);
      geneScore = Math.max(0, geneScore - 0.2);
    }

    if (missing.length > 0) {
      findings.push(`${name}: missing ${missing.join(", ")}`);
    }

    totalScore += geneScore / 0.6;
  }

  const score = phenotypes.size > 0 ? Math.min(1, totalScore / phenotypes.size) : 0;

  if (findings.length > 0) {
    suggestions.push(`${findings.length} compliance issues found. Run with verbose=true for per-gene details.`);
  }

  return { name: "Protocol Compliance", score, findings, suggestions };
}

function analyzeSecurityVulnerabilities(genesDir: string, phenotypes: Map<string, Phenotype>): DimensionResult {
  const findings: string[] = [];
  const suggestions: string[] = [];

  const dangerousPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /eval\s*\(/, label: "eval()" },
    { pattern: /new\s+Function\s*\(/, label: "new Function()" },
    { pattern: /child_process/, label: "child_process" },
    { pattern: /sk-[a-zA-Z0-9]{20,}/, label: "hardcoded OpenAI key" },
    { pattern: /ghp_[a-zA-Z0-9]{36}/, label: "hardcoded GitHub PAT" },
    { pattern: /glpat-[a-zA-Z0-9]{20}/, label: "hardcoded GitLab PAT" },
    { pattern: /AKIA[A-Z0-9]{16}/, label: "hardcoded AWS access key" },
  ];

  let vulnerableCount = 0;

  for (const [name] of phenotypes) {
    const source = readImplementation(genesDir, name);
    if (!source) continue;

    const geneIssues: string[] = [];
    for (const { pattern, label } of dangerousPatterns) {
      if (pattern.test(source)) {
        geneIssues.push(label);
      }
    }

    if (geneIssues.length > 0) {
      vulnerableCount++;
      findings.push(`${name}: detected ${geneIssues.join(", ")}`);
      suggestions.push(`${name}: remove or sandbox dangerous patterns (${geneIssues.join(", ")})`);
    }
  }

  const genesWithSource = [...phenotypes.keys()].filter(
    (n) => readImplementation(genesDir, n) !== null
  ).length;
  const score = genesWithSource > 0 ? 1.0 - vulnerableCount / genesWithSource : 1.0;

  return { name: "Security Vulnerabilities", score: Math.max(0, score), findings, suggestions };
}

function analyzeQualityScore(genesDir: string, phenotypes: Map<string, Phenotype>): DimensionResult {
  const findings: string[] = [];
  const suggestions: string[] = [];
  let totalQuality = 0;

  const genesParent = join(genesDir, "..");

  for (const [name, pheno] of phenotypes) {
    let q = 0;
    const missing: string[] = [];

    if (pheno.description) q += 0.1;
    else missing.push("description");

    if (pheno.tags && pheno.tags.length > 0) q += 0.1;
    else missing.push("tags");

    const hasInputProps = pheno.inputSchema?.properties && Object.keys(pheno.inputSchema.properties).length > 0;
    const hasOutputProps = pheno.outputSchema?.properties && Object.keys(pheno.outputSchema.properties).length > 0;
    if (hasInputProps && hasOutputProps) q += 0.3;
    else missing.push("complete schema");

    if (hasImplementation(genesDir, name)) q += 0.3;
    else missing.push("express() implementation");

    const testPath = join(genesParent, "tests", "unit", `${name}.test.ts`);
    if (existsSync(testPath)) q += 0.2;
    else missing.push("unit tests");

    if (missing.length > 0) {
      findings.push(`${name} (${q.toFixed(2)}): missing ${missing.join(", ")}`);
    }

    totalQuality += q;
  }

  const score = phenotypes.size > 0 ? totalQuality / phenotypes.size : 0;

  if (score < 0.7) {
    suggestions.push("Average quality below 0.7. Prioritize adding tests and completing schemas.");
  }

  return { name: "Quality Score", score: Math.min(1, score), findings, suggestions };
}

function analyzeEvolutionSuggestions(genesDir: string, phenotypes: Map<string, Phenotype>): DimensionResult {
  const findings: string[] = [];
  const suggestions: string[] = [];
  let actionable = 0;
  let total = 0;

  for (const [name, pheno] of phenotypes) {
    total++;
    let needsWork = false;

    if (pheno.fidelity === "Wrapped") {
      suggestions.push(`${name}: Wrapped → consider upgrading to Hybrid or Native for better portability`);
      needsWork = true;
    }

    const hasInputProps = pheno.inputSchema?.properties && Object.keys(pheno.inputSchema.properties).length > 0;
    const hasOutputProps = pheno.outputSchema?.properties && Object.keys(pheno.outputSchema.properties).length > 0;
    if (!hasInputProps || !hasOutputProps) {
      suggestions.push(`${name}: incomplete schema — add inputSchema/outputSchema properties`);
      needsWork = true;
    }

    if (!hasImplementation(genesDir, name)) {
      suggestions.push(`${name}: no express() implementation — add index.ts`);
      needsWork = true;
    }

    if (needsWork) actionable++;
  }

  findings.push(`${actionable}/${total} genes have evolution opportunities`);
  const score = total > 0 ? 1.0 - actionable / total : 1.0;

  return { name: "Evolution Suggestions", score: Math.max(0, score), findings, suggestions };
}

function analyzeRuntimeHealth(phenotypes: Map<string, Phenotype>): DimensionResult {
  const findings: string[] = [];
  const suggestions: string[] = [];
  const logDir = join(homedir(), ".rotifer", "run-logs");
  let totalScore = 0;
  let genesWithLogs = 0;

  for (const [name] of phenotypes) {
    const logPath = join(logDir, `${name}.jsonl`);
    if (!existsSync(logPath)) continue;

    genesWithLogs++;
    try {
      const lines = readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);

      let successes = 0;
      let totalDuration = 0;
      let parsed = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as RunLogEntry;
          parsed++;
          if (entry.success) successes++;
          totalDuration += entry.durationMs ?? 0;
        } catch {
          /* skip malformed lines */
        }
      }

      if (parsed > 0) {
        const successRate = successes / parsed;
        const avgDuration = totalDuration / parsed;
        findings.push(`${name}: ${parsed} runs, ${(successRate * 100).toFixed(1)}% success, avg ${avgDuration.toFixed(0)}ms`);
        totalScore += successRate;
        if (successRate < 0.8) {
          suggestions.push(`${name}: success rate ${(successRate * 100).toFixed(1)}% — investigate failures`);
        }
      }
    } catch {
      findings.push(`${name}: log file unreadable`);
    }
  }

  const score = genesWithLogs > 0 ? totalScore / genesWithLogs : 1.0;

  if (genesWithLogs === 0) {
    findings.push("No runtime logs found — genes have not been executed yet");
  }

  return { name: "Runtime Health", score: Math.max(0, Math.min(1, score)), findings, suggestions };
}

function analyzeDependencyChains(genesDir: string, phenotypes: Map<string, Phenotype>): DimensionResult {
  const findings: string[] = [];
  const suggestions: string[] = [];
  let brokenDeps = 0;
  let totalDeps = 0;

  for (const [name, pheno] of phenotypes) {
    const deps = pheno.dependencies ?? [];
    for (const dep of deps) {
      totalDeps++;
      if (!phenotypes.has(dep) && !existsSync(join(genesDir, dep))) {
        brokenDeps++;
        findings.push(`${name} → ${dep}: dependency not found`);
        suggestions.push(`${name}: install or create missing dependency "${dep}"`);
      }
    }
  }

  if (totalDeps === 0) {
    findings.push("No inter-gene dependencies declared");
  } else {
    findings.push(`${totalDeps} dependencies checked, ${brokenDeps} broken`);
  }

  const score = totalDeps > 0 ? 1.0 - brokenDeps / totalDeps : 1.0;

  return { name: "Dependency Chain Health", score: Math.max(0, score), findings, suggestions };
}

export function express(input: HealthInput): HealthOutput {
  const genesDir = input.genesDir ?? "./genes";
  const phenotypes = loadPhenotypes(genesDir);
  const geneCount = phenotypes.size;

  const dimensions: DimensionResult[] = [
    analyzeCapabilityDistribution(phenotypes),
    analyzeProtocolCompliance(genesDir, phenotypes),
    analyzeSecurityVulnerabilities(genesDir, phenotypes),
    analyzeQualityScore(genesDir, phenotypes),
    analyzeEvolutionSuggestions(genesDir, phenotypes),
    analyzeRuntimeHealth(phenotypes),
    analyzeDependencyChains(genesDir, phenotypes),
  ];

  const overallScore = dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length;

  const ranked = [...dimensions].sort((a, b) => a.score - b.score);
  const recommendations: string[] = [];
  for (const dim of ranked.slice(0, 3)) {
    if (dim.score < 0.9 && dim.suggestions.length > 0) {
      recommendations.push(`[${dim.name}] ${dim.suggestions[0]}`);
    }
  }

  if (!input.verbose) {
    for (const dim of dimensions) {
      if (dim.findings.length > 5) dim.findings = dim.findings.slice(0, 5);
      if (dim.suggestions.length > 3) dim.suggestions = dim.suggestions.slice(0, 3);
    }
  }

  const grade =
    overallScore >= 0.9 ? "Excellent" :
    overallScore >= 0.7 ? "Good" :
    overallScore >= 0.5 ? "Fair" :
    "Needs Attention";

  const summary = `Gene Library Health: ${grade} (${(overallScore * 100).toFixed(1)}%) — ${geneCount} genes scanned across 7 dimensions`;

  return { summary, dimensions, overallScore, geneCount, recommendations };
}

export function display(output: HealthOutput, options?: { verbose?: boolean }): void {
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const BLUE = "\x1b[34m";
  const CYAN = "\x1b[36m";

  const bar = (score: number, width = 20): string => {
    const clamped = Math.max(0, Math.min(1, score));
    const filled = Math.round(clamped * width);
    return `${GREEN}${"█".repeat(filled)}${DIM}${"░".repeat(Math.max(0, width - filled))}${RESET}`;
  };

  const dimIcon = (score: number): string => {
    if (score > 0.7) return `${GREEN}✓${RESET}`;
    if (score > 0.4) return `${YELLOW}!${RESET}`;
    return `${RED}✗${RESET}`;
  };

  console.log(`${BOLD}${CYAN}Gene Health Report${RESET}`);
  console.log(`${DIM}${output.summary}${RESET}`);
  console.log();
  console.log(
    `${BOLD}Overall${RESET}  ${bar(output.overallScore)} ${BLUE}${(output.overallScore * 100).toFixed(1)}%${RESET}  ${DIM}(${output.geneCount} genes)${RESET}`
  );
  console.log();

  const maxNameLen = Math.max(...output.dimensions.map((d) => d.name.length));

  for (const d of output.dimensions) {
    const icon = dimIcon(d.score);
    const padded = d.name.padEnd(maxNameLen);
    const pct = `${(d.score * 100).toFixed(0)}%`.padStart(4);
    console.log(
      `${icon} ${BOLD}${padded}${RESET}  ${bar(d.score)} ${CYAN}${pct}${RESET}`
    );
    if (options?.verbose && d.findings.length > 0) {
      console.log(`  ${DIM}Findings:${RESET}`);
      for (const f of d.findings) {
        console.log(`    ${DIM}•${RESET} ${f}`);
      }
    }
  }

  console.log();
  console.log(`${BOLD}Recommendations${RESET}`);
  if (output.recommendations.length === 0) {
    console.log(`  ${DIM}(none)${RESET}`);
  } else {
    for (const r of output.recommendations) {
      console.log(`  ${YELLOW}→${RESET} ${r}`);
    }
  }
}
