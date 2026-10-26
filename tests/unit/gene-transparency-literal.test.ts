import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_GENE_TRANSPARENCIES } from "../../src/types/phenotype.js";

/**
 * Spec §4.2 serialises `GeneTransparency` as OPEN / OPAQUE. The PascalCase
 * literals "Open" / "Opaque" are legacy: the validator accepts them with a
 * warning (W0140), never an error, so a new gene can copy one from an older
 * gene and nothing fails. genes/tavily-web-search did exactly that (#470,
 * copied from genesis-web-search) and passed review and CI.
 *
 * The genes below already carry a legacy literal. They are listed rather than
 * rewritten here: the phenotype is hashed into a gene's ID, so changing them
 * is its own decision. This list may shrink; it must never grow.
 */
const LEGACY_TRANSPARENCY = [
  "academic-writer",
  "ai-components",
  "algorithmic-art",
  "answer-synthesizer",
  "api-designer",
  "audit-reporter",
  "auto-coder",
  "auto-writer",
  "brand-personality",
  "business-writer",
  "chain-reader",
  "citation-manager",
  "clawhub-web-search",
  "code-complexity",
  "content-optimizer",
  "content-quality-analyzer",
  "copywriter",
  "creative-writer",
  "data-formatter",
  "data-modeler",
  "debugger",
  "design-tokens",
  "devops-automator",
  "doc-coauthoring",
  "doc-retrieval",
  "docs-writer",
  "evolve-life-bitwise",
  "evolve-life-sparse",
  "evolve-life",
  "fact-checker",
  "gene-health-scanner",
  "genesis-code-format",
  "genesis-file-read",
  "genesis-l0-constraint",
  "genesis-web-search-lite",
  "genesis-web-search",
  "git-workflow",
  "guard-balanced",
  "guard-strict",
  "json-validator",
  "license-advisor",
  "logic-architect",
  "markdown-formatter",
  "med-drug-interaction",
  "med-symptom-triage",
  "orch",
  "particle-barneshut",
  "particle-brute",
  "particle-spatial",
  "performance-optimizer",
  "plagiarism-checker",
  "product-manager",
  "project-reviewer",
  "prompt-engineer",
  "prompt-review-perf",
  "prompt-review-readability",
  "prompt-review-security",
  "quant-mean-reversion",
  "quant-momentum-native",
  "quant-momentum",
  "readability-analyzer",
  "rule-router-frequency",
  "rule-router-relevance",
  "security-auditor",
  "security-scanner",
  "seo-optimizer",
  "sirchmunk-search",
  "solidity-parser",
  "spread-analyzer",
  "style-optimizer",
  "tech-lead",
  "telegram-bot-notifier",
  "testing-strategist",
  "text-summarizer",
  "tone-analyzer",
  "translator",
  "ui-components",
  "uiux-analyzer",
  "uiux-designer",
  "uiux-reporter",
  "url-extractor",
  "ux-patterns",
  "vuln-detector",
  "web3-components",
] as const;

const GENES_DIR = join(__dirname, "..", "..", "genes");

function legacyTransparencyGenes(): string[] {
  return readdirSync(GENES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(GENES_DIR, d.name, "phenotype.json")))
    .filter((d) => {
      const p = JSON.parse(readFileSync(join(GENES_DIR, d.name, "phenotype.json"), "utf-8"));
      return typeof p.transparency === "string" && p.transparency in LEGACY_GENE_TRANSPARENCIES;
    })
    .map((d) => d.name)
    .sort();
}

describe("gene transparency literals", () => {
  it("no gene outside the frozen list uses a legacy literal", () => {
    const allowed = new Set<string>(LEGACY_TRANSPARENCY);
    const added = legacyTransparencyGenes().filter((g) => !allowed.has(g));
    expect(added, "use \"OPEN\" / \"OPAQUE\" (spec §4.2), not \"Open\" / \"Opaque\"").toEqual([]);
  });

  it("the frozen list names only genes that still need it", () => {
    const current = new Set(legacyTransparencyGenes());
    const stale = LEGACY_TRANSPARENCY.filter((g) => !current.has(g));
    expect(stale, "remove these from LEGACY_TRANSPARENCY").toEqual([]);
  });
});
