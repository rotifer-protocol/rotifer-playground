/**
 * Development Genome validation tests (ADR-085)
 * Verifies Rule Router Gene variants and Code Review Assistant Genome.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const GENES_DIR = join(__dirname, "../../genes");

function readGeneJson(geneName: string, file: string) {
  const path = join(GENES_DIR, geneName, file);
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ─── Rule Router Gene Variants ────────────────────────────────

describe("Rule Router Gene: frequency variant", () => {
  const phenotype = readGeneJson("rule-router-frequency", "phenotype.json");

  it("has prompt.rule-router domain", () => {
    expect(phenotype.domain).toBe("prompt.rule-router");
  });

  it("has required input fields", () => {
    const props = phenotype.inputSchema.properties;
    expect(props.userMessage).toBeDefined();
    expect(props.availableRules).toBeDefined();
    expect(props.contextBudget).toBeDefined();
  });

  it("has llmRequirements with system prompt", () => {
    expect(phenotype.llmRequirements).toBeDefined();
    expect(phenotype.llmRequirements.systemPromptPath).toBe("system-prompt.md");
  });

  it("system prompt file exists", () => {
    expect(existsSync(join(GENES_DIR, "rule-router-frequency", "system-prompt.md"))).toBe(true);
  });

  it("has fitnessConfig with routeHitRate and contextSavings", () => {
    const dims = phenotype.fitnessConfig.dimensions;
    expect(dims.routeHitRate).toBeDefined();
    expect(dims.contextSavings).toBeDefined();
    const totalWeight = Object.values(dims).reduce((s: number, d: any) => s + d.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 2);
  });

  it("is Wrapped fidelity", () => {
    expect(phenotype.fidelity).toBe("Wrapped");
  });

  it("source is development-genome", () => {
    expect(phenotype.source).toBe("development-genome");
  });
});

describe("Rule Router Gene: relevance variant", () => {
  const phenotype = readGeneJson("rule-router-relevance", "phenotype.json");

  it("has same domain as frequency variant", () => {
    expect(phenotype.domain).toBe("prompt.rule-router");
  });

  it("has chain-of-thought enabled (differs from frequency)", () => {
    expect(phenotype.llmRequirements.chainOfThought).toBe(true);
  });

  it("description mentions relevance strategy", () => {
    expect(phenotype.description).toMatch(/relevance/i);
  });

  it("has same inputSchema structure as frequency variant", () => {
    const freqPhenotype = readGeneJson("rule-router-frequency", "phenotype.json");
    expect(Object.keys(phenotype.inputSchema.properties).sort()).toEqual(
      Object.keys(freqPhenotype.inputSchema.properties).sort(),
    );
  });
});

describe("Rule Router: A vs B differentiation", () => {
  const freqPrompt = readFileSync(join(GENES_DIR, "rule-router-frequency", "system-prompt.md"), "utf-8");
  const relPrompt = readFileSync(join(GENES_DIR, "rule-router-relevance", "system-prompt.md"), "utf-8");

  it("frequency variant mentions frequency-based sorting", () => {
    expect(freqPrompt).toMatch(/frequency/i);
    expect(freqPrompt).toMatch(/sort.*frequency|frequency.*descending/i);
  });

  it("relevance variant mentions relevance scoring", () => {
    expect(relPrompt).toMatch(/relevance/i);
    expect(relPrompt).toMatch(/relevanceScore|triggerWord.*overlap/i);
  });

  it("strategies are meaningfully different", () => {
    expect(freqPrompt).not.toBe(relPrompt);
    const freqHasBackfill = freqPrompt.includes("backfill");
    const relHasNoBackfill = relPrompt.includes("no backfill") || relPrompt.includes("never selected");
    expect(freqHasBackfill || relHasNoBackfill).toBe(true);
  });
});

// ─── Code Review Prompt Gene Variants ─────────────────────────

const PROMPT_VARIANTS = ["prompt-review-security", "prompt-review-perf", "prompt-review-readability"];

describe("Code Review Prompt Genes (3 variants)", () => {
  for (const name of PROMPT_VARIANTS) {
    describe(name, () => {
      const phenotype = readGeneJson(name, "phenotype.json");

      it("has prompt.code-review domain", () => {
        expect(phenotype.domain).toBe("prompt.code-review");
      });

      it("has code input field", () => {
        expect(phenotype.inputSchema.properties.code).toBeDefined();
        expect(phenotype.inputSchema.required).toContain("code");
      });

      it("has findings array in output", () => {
        expect(phenotype.outputSchema.properties.findings).toBeDefined();
        expect(phenotype.outputSchema.properties.findings.type).toBe("array");
      });

      it("has fitnessConfig weights summing to 1.0", () => {
        const dims = phenotype.fitnessConfig.dimensions;
        const total = Object.values(dims).reduce((s: number, d: any) => s + d.weight, 0);
        expect(total).toBeCloseTo(1.0, 2);
      });

      it("has system prompt file", () => {
        expect(existsSync(join(GENES_DIR, name, "system-prompt.md"))).toBe(true);
      });
    });
  }

  it("all 3 variants have the same domain", () => {
    const domains = PROMPT_VARIANTS.map((n) => readGeneJson(n, "phenotype.json").domain);
    expect(new Set(domains).size).toBe(1);
  });

  it("each variant has a distinct specialization", () => {
    const descriptions = PROMPT_VARIANTS.map((n) => readGeneJson(n, "phenotype.json").description);
    expect(descriptions[0]).toMatch(/security/i);
    expect(descriptions[1]).toMatch(/performance/i);
    expect(descriptions[2]).toMatch(/readability/i);
  });
});

// ─── Guard Gene Variants ──────────────────────────────────────

const GUARD_VARIANTS = ["guard-strict", "guard-balanced"];

describe("Guard Genes (2 variants)", () => {
  for (const name of GUARD_VARIANTS) {
    describe(name, () => {
      const phenotype = readGeneJson(name, "phenotype.json");

      it("has guard.security domain", () => {
        expect(phenotype.domain).toBe("guard.security");
      });

      it("has reviewOutput input field", () => {
        expect(phenotype.inputSchema.properties.reviewOutput).toBeDefined();
      });

      it("has filteredFindings and rejected in output", () => {
        expect(phenotype.outputSchema.properties.filteredFindings).toBeDefined();
        expect(phenotype.outputSchema.properties.rejected).toBeDefined();
      });

      it("has guardConfig", () => {
        expect(phenotype.guardConfig).toBeDefined();
        expect(phenotype.guardConfig.mode).toBe("filter");
        expect(phenotype.guardConfig.vgContribution).toBe("Security_Leak_Risk");
      });

      it("has system prompt file", () => {
        expect(existsSync(join(GENES_DIR, name, "system-prompt.md"))).toBe(true);
      });
    });
  }

  it("strict has higher precision weight than balanced", () => {
    const strict = readGeneJson("guard-strict", "phenotype.json");
    const balanced = readGeneJson("guard-balanced", "phenotype.json");
    expect(strict.fitnessConfig.dimensions.precision.weight).toBeGreaterThan(
      balanced.fitnessConfig.dimensions.precision.weight,
    );
  });

  it("balanced has higher recall weight than strict", () => {
    const strict = readGeneJson("guard-strict", "phenotype.json");
    const balanced = readGeneJson("guard-balanced", "phenotype.json");
    expect(balanced.fitnessConfig.dimensions.recall.weight).toBeGreaterThan(
      strict.fitnessConfig.dimensions.recall.weight,
    );
  });

  it("strict has lower targetFalsePositiveRate", () => {
    const strict = readGeneJson("guard-strict", "phenotype.json");
    const balanced = readGeneJson("guard-balanced", "phenotype.json");
    expect(strict.guardConfig.targetFalsePositiveRate).toBeLessThan(
      balanced.guardConfig.targetFalsePositiveRate,
    );
  });

  it("strict has higher targetFalseNegativeRate (tolerates missing issues)", () => {
    const strict = readGeneJson("guard-strict", "phenotype.json");
    const balanced = readGeneJson("guard-balanced", "phenotype.json");
    expect(strict.guardConfig.targetFalseNegativeRate).toBeGreaterThan(
      balanced.guardConfig.targetFalseNegativeRate,
    );
  });
});

// ─── Genome Combination Matrix ────────────────────────────────

describe("Code Review Assistant Genome (3×2 = 6 combinations)", () => {
  it("has exactly 3 prompt variants × 2 guard variants = 6 possible genomes", () => {
    const combinations = PROMPT_VARIANTS.flatMap((p) => GUARD_VARIANTS.map((g) => `${p}+${g}`));
    expect(combinations).toHaveLength(6);
  });

  it("all prompt variants share compatible outputSchema with guard inputSchema", () => {
    for (const pName of PROMPT_VARIANTS) {
      const promptOutput = readGeneJson(pName, "phenotype.json").outputSchema;
      for (const gName of GUARD_VARIANTS) {
        const guardInput = readGeneJson(gName, "phenotype.json").inputSchema;
        expect(promptOutput.properties.findings).toBeDefined();
        expect(guardInput.properties.reviewOutput.properties.findings).toBeDefined();
      }
    }
  });

  it("all 7 development genome genes exist", () => {
    const allGenes = [...PROMPT_VARIANTS, ...GUARD_VARIANTS, "rule-router-frequency", "rule-router-relevance"];
    for (const gene of allGenes) {
      expect(existsSync(join(GENES_DIR, gene, "phenotype.json"))).toBe(true);
      expect(existsSync(join(GENES_DIR, gene, "system-prompt.md"))).toBe(true);
    }
  });
});

// ─── Phenotype Standard Compliance ────────────────────────────

describe("LLM-Native Gene Phenotype Standard compliance", () => {
  const allGenes = [
    ...PROMPT_VARIANTS,
    ...GUARD_VARIANTS,
    "rule-router-frequency",
    "rule-router-relevance",
  ];

  for (const name of allGenes) {
    describe(`${name} standard compliance`, () => {
      const phenotype = readGeneJson(name, "phenotype.json");

      it("has domain matching prompt.* or guard.*", () => {
        expect(phenotype.domain).toMatch(/^(prompt|guard)\./);
      });

      it("has version field", () => {
        expect(phenotype.version).toBeDefined();
      });

      it("has correct fidelity", () => {
        const expectedFidelity = name.startsWith("guard-") ? "Native" : "Wrapped";
        expect(phenotype.fidelity).toBe(expectedFidelity);
      });

      it("has llmRequirements with templateFormat", () => {
        expect(phenotype.llmRequirements.templateFormat).toBeDefined();
      });

      it("has llmRequirements.templateVariables matching inputSchema keys", () => {
        const inputKeys = Object.keys(phenotype.inputSchema.properties);
        for (const v of phenotype.llmRequirements.templateVariables) {
          expect(inputKeys).toContain(v);
        }
      });

      it("has expectedOutputFormat: json", () => {
        expect(phenotype.llmRequirements.expectedOutputFormat).toBe("json");
      });
    });
  }
});
