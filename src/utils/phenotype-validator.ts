import * as display from "./display.js";
import {
  DEGRADATION_BEHAVIORS,
  DEGRADATION_MODES,
  EXECUTION_MODELS,
  GENE_TRANSPARENCIES,
  GUARD_POSITIONS,
  LEGACY_DEGRADATION_BEHAVIORS,
  LEGACY_GENE_TRANSPARENCIES,
  SYNTHESIS_METHODS,
  TEMPLATE_FORMATS,
} from "../types/phenotype.js";

// Validator imports the enum const arrays from src/types/phenotype.ts (the
// single source of truth — v0.9.1 §3.3). Local aliases keep call-sites compact.
const VALID_TEMPLATE_FORMATS = TEMPLATE_FORMATS;
const VALID_GUARD_POSITIONS = GUARD_POSITIONS;
const VALID_SYNTHESIS_METHODS = SYNTHESIS_METHODS;
// v0.9.1 §3.3 (ADR-253 D4.4): execution-model enum on the Phenotype.
// Legacy Genes are pre-§3.3 and lack the field — those are treated as BATCH at
// runtime (silent default in rotifer.ai's chat URL guard). The validator only
// flags the field when it IS present but with an unknown value.
const VALID_EXECUTION_MODELS = EXECUTION_MODELS;
// v0.9 §3.11 Hybrid Fidelity (spec §4.2 v2.11, ADR-220 D-04): three Optional
// Phenotype fields enabling external API integration with explicit semantic
// declaration, dry-run protocol, and graceful degradation contracts.
const VALID_DEGRADATION_BEHAVIORS = DEGRADATION_BEHAVIORS;
const VALID_DEGRADATION_MODES = DEGRADATION_MODES;
// v0.9.1 §3.3 F8: transparency enum (spec §4.2 GeneTransparency).
const VALID_GENE_TRANSPARENCIES = GENE_TRANSPARENCIES;

interface ValidationDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}

function collectDiagnostics(phenotype: Record<string, unknown>): ValidationDiagnostic[] {
  const diags: ValidationDiagnostic[] = [];
  const domain = phenotype.domain as string | undefined;
  const isPrompt = domain?.startsWith("prompt.");
  const isGuard = domain?.startsWith("guard.");

  const llm = phenotype.llmRequirements as Record<string, unknown> | undefined;
  if (llm) {
    if (!llm.templateFormat || !(VALID_TEMPLATE_FORMATS as readonly string[]).includes(llm.templateFormat as string)) {
      diags.push({
        level: "warning",
        code: "W0080",
        message: `llmRequirements.templateFormat should be one of: ${VALID_TEMPLATE_FORMATS.join(", ")}`,
      });
    }

    const vars = llm.templateVariables as string[] | undefined;
    if (!vars || !Array.isArray(vars) || vars.length === 0) {
      diags.push({
        level: "error",
        code: "E0080",
        message: "llmRequirements.templateVariables must be a non-empty array",
      });
    } else {
      const inputProps = (phenotype.inputSchema as Record<string, unknown>)?.properties as
        | Record<string, unknown>
        | undefined;
      if (inputProps) {
        for (const v of vars) {
          if (!(v in inputProps)) {
            diags.push({
              level: "error",
              code: "E0081",
              message: `llmRequirements.templateVariables contains '${v}' not found in inputSchema.properties`,
            });
          }
        }
      }
    }

    if (!isPrompt) {
      diags.push({
        level: "warning",
        code: "W0081",
        message: `Gene has llmRequirements but domain '${domain}' does not start with 'prompt.'`,
      });
    }
  }

  const guard = phenotype.guardConfig as Record<string, unknown> | undefined;
  if (guard) {
    if (!guard.position || !(VALID_GUARD_POSITIONS as readonly string[]).includes(guard.position as string)) {
      diags.push({
        level: "error",
        code: "E0082",
        message: `guardConfig.position must be one of: ${VALID_GUARD_POSITIONS.join(", ")}`,
      });
    }

    const cats = guard.categories as string[] | undefined;
    if (!cats || !Array.isArray(cats) || cats.length === 0) {
      diags.push({
        level: "error",
        code: "E0083",
        message: "guardConfig.categories must be a non-empty array",
      });
    }

    const threshold = guard.riskThreshold as number | undefined;
    if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
      diags.push({
        level: "error",
        code: "E0084",
        message: `guardConfig.riskThreshold must be between 0.0 and 1.0 (got ${threshold})`,
      });
    }

    if (!isGuard) {
      diags.push({
        level: "warning",
        code: "W0082",
        message: `Gene has guardConfig but domain '${domain}' does not start with 'guard.'`,
      });
    }
  }

  const sm = phenotype.synthesisMethod as string | undefined;
  if (sm !== undefined && !(VALID_SYNTHESIS_METHODS as readonly string[]).includes(sm)) {
    diags.push({
      level: "error",
      code: "E0090",
      message: `synthesisMethod must be one of: ${VALID_SYNTHESIS_METHODS.join(", ")} (got '${sm}')`,
    });
  }

  // v0.9.1 §3.3: executionModel enum validation.
  const em = phenotype.executionModel as string | undefined;
  if (em !== undefined && !(VALID_EXECUTION_MODELS as readonly string[]).includes(em)) {
    diags.push({
      level: "error",
      code: "E0100",
      message: `executionModel must be one of: ${VALID_EXECUTION_MODELS.join(", ")} (got '${em}')`,
    });
  }

  // CHAT Agents should have a description (used as system prompt by rotifer.ai's
  // chat surface — without it the LLM has no Agent identity and replies generically).
  if (em === "CHAT") {
    const desc = phenotype.description as string | undefined;
    if (!desc || desc.trim().length < 10) {
      diags.push({
        level: "warning",
        code: "W0100",
        message:
          "CHAT executionModel Phenotype has empty or very short description (<10 chars); " +
          "the chat surface uses description as the Agent system prompt, so a richer description " +
          "directly improves conversation quality",
      });
    }
  }

  // BATCH/EVENT_DRIVEN Genes should not declare a chat-style systemPrompt
  // (forward-compat: if a future field 'systemPrompt' is added, warn when misused).
  const sp = phenotype.systemPrompt as string | undefined;
  if (sp !== undefined && em !== undefined && em !== "CHAT") {
    diags.push({
      level: "warning",
      code: "W0101",
      message: `systemPrompt is set but executionModel is '${em}', not 'CHAT' — systemPrompt is ignored outside chat surfaces`,
    });
  }

  // v0.9.1 §3.3 F8: transparency enum validation (spec §4.2 GeneTransparency).
  // Optional field (legacy genes lack it) — only flagged when present.
  const tr = phenotype.transparency as string | undefined;
  if (tr !== undefined && tr in LEGACY_GENE_TRANSPARENCIES) {
    diags.push({
      level: "warning",
      code: "W0140",
      message:
        `transparency '${tr}' is a deprecated legacy literal; use ` +
        `'${LEGACY_GENE_TRANSPARENCIES[tr]}' instead (spec §4.2 GeneTransparency). ` +
        `Legacy values are removed in v0.9.2.`,
    });
  } else if (tr !== undefined && !(VALID_GENE_TRANSPARENCIES as readonly string[]).includes(tr)) {
    diags.push({
      level: "error",
      code: "E0140",
      message: `transparency must be one of: ${VALID_GENE_TRANSPARENCIES.join(", ")} (got '${tr}')`,
    });
  }

  if (isPrompt && phenotype.fidelity === "Native") {
    diags.push({
      level: "warning",
      code: "W0083",
      message: "Prompt Gene with fidelity 'Native' is unusual — consider 'Wrapped' or 'Hybrid'",
    });
  }

  if (isGuard && !guard) {
    diags.push({
      level: "info",
      code: "I0080",
      message: "Guard domain gene missing guardConfig — consider adding it for V(g) integration",
    });
  }

  // v0.9 §3.11 Hybrid Fidelity validation (spec §4.2 v2.11, ADR-220 §"D-04").
  const extDeps = phenotype.externalDependencies as unknown[] | undefined;
  if (extDeps !== undefined) {
    if (!Array.isArray(extDeps)) {
      diags.push({
        level: "error",
        code: "E0110",
        message: "externalDependencies must be an array",
      });
    } else {
      for (let i = 0; i < extDeps.length; i++) {
        const dep = extDeps[i] as Record<string, unknown> | undefined;
        if (!dep || typeof dep !== "object") {
          diags.push({
            level: "error",
            code: "E0111",
            message: `externalDependencies[${i}] must be an object`,
          });
          continue;
        }
        if (typeof dep.apiType !== "string" || dep.apiType.length === 0) {
          diags.push({
            level: "error",
            code: "E0112",
            message: `externalDependencies[${i}].apiType is required (non-empty string)`,
          });
        }
        if (typeof dep.semanticTag !== "string" || dep.semanticTag.length === 0) {
          diags.push({
            level: "error",
            code: "E0113",
            message: `externalDependencies[${i}].semanticTag is required (non-empty string)`,
          });
        }
        const db = dep.degradationBehavior as string | undefined;
        const isDbValid =
          db !== undefined && (VALID_DEGRADATION_BEHAVIORS as readonly string[]).includes(db);
        const isDbLegacy = db !== undefined && db in LEGACY_DEGRADATION_BEHAVIORS;
        if (isDbLegacy) {
          // Pre-§3.3 collapsed literal — still valid through the v0.9.1 grace
          // window, but warn and point at the spec replacement (removed v0.9.2).
          diags.push({
            level: "warning",
            code: "W0114",
            message:
              `externalDependencies[${i}].degradationBehavior '${db}' is a deprecated ` +
              `legacy value; use '${LEGACY_DEGRADATION_BEHAVIORS[db as string]}' instead ` +
              `(spec §4.2). Legacy values are removed in v0.9.2.`,
          });
        } else if (!isDbValid) {
          diags.push({
            level: "error",
            code: "E0114",
            message:
              `externalDependencies[${i}].degradationBehavior must be one of: ` +
              `${VALID_DEGRADATION_BEHAVIORS.join(", ")} (got '${db ?? "<undefined>"}')`,
          });
        }
        // ADR-327: optional domains / credentials — arrays of non-empty
        // strings when present.
        const isStringArray = (v: unknown): v is string[] =>
          Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
        if (dep.domains !== undefined && !isStringArray(dep.domains)) {
          diags.push({
            level: "error",
            code: "E0115",
            message: `externalDependencies[${i}].domains must be an array of non-empty strings`,
          });
        }
        if (dep.credentials !== undefined && !isStringArray(dep.credentials)) {
          diags.push({
            level: "error",
            code: "E0116",
            message: `externalDependencies[${i}].credentials must be an array of non-empty strings (env NAMES only — never values)`,
          });
        }
        // A dependency without domains can never be fetched against — the
        // runtime refuses unattributable request hosts (ADR-327 B-2).
        if (phenotype.network !== undefined && dep.domains === undefined) {
          diags.push({
            level: "warning",
            code: "W0115",
            message:
              `externalDependencies[${i}] declares no domains — rotifer.net.fetch requires ` +
              `every request host to be attributable to a declared dependency, so this ` +
              `dependency cannot be reached at runtime`,
          });
        }
      }
    }
  }

  // Hybrid fidelity should declare external dependencies — case-insensitive
  // match per Q2=c (Phase 5 normalization deferred): spec enum is "HYBRID"
  // (uppercase) but plan / runtime use "Hybrid" / "hybrid", so accept all.
  const fidelityRaw = phenotype.fidelity as string | undefined;
  const fidelityLower = fidelityRaw?.toLowerCase();
  if (fidelityLower === "hybrid" && (extDeps === undefined || (Array.isArray(extDeps) && extDeps.length === 0))) {
    diags.push({
      level: "warning",
      code: "W0110",
      message:
        "Gene has fidelity 'Hybrid' but does not declare externalDependencies — " +
        "Hybrid genes that perform external calls SHOULD declare both `network` (protocol layer) " +
        "and `externalDependencies` (semantic layer) per spec §3.11",
    });
  }

  const sim = phenotype.simulationSpec as Record<string, unknown> | undefined;
  if (sim !== undefined) {
    if (typeof sim.supportsDryRun !== "boolean") {
      diags.push({
        level: "error",
        code: "E0120",
        message: "simulationSpec.supportsDryRun must be a boolean",
      });
    }
    const re = sim.resourceEstimate as Record<string, unknown> | undefined;
    if (!re || typeof re !== "object") {
      diags.push({
        level: "error",
        code: "E0121",
        message: "simulationSpec.resourceEstimate is required (object with estimatedLatencyMs)",
      });
    } else if (typeof re.estimatedLatencyMs !== "number" || re.estimatedLatencyMs < 0) {
      diags.push({
        level: "error",
        code: "E0122",
        message: "simulationSpec.resourceEstimate.estimatedLatencyMs must be a non-negative number",
      });
    }
  }

  const deg = phenotype.degradationSpec as Record<string, unknown> | undefined;
  if (deg !== undefined) {
    const mode = deg.mode as string | undefined;
    if (mode === undefined || !(VALID_DEGRADATION_MODES as readonly string[]).includes(mode)) {
      diags.push({
        level: "error",
        code: "E0130",
        message:
          `degradationSpec.mode must be one of: ${VALID_DEGRADATION_MODES.join(", ")} ` +
          `(got '${mode ?? "<undefined>"}')`,
      });
    }
    const minDeps = deg.minimumDependencies;
    if (!Array.isArray(minDeps)) {
      diags.push({
        level: "error",
        code: "E0131",
        message: "degradationSpec.minimumDependencies must be an array of semanticTag strings",
      });
    }
  }

  return diags;
}

export function validateLlmNativePhenotype(
  phenotype: Record<string, unknown>,
  filePath: string,
): void {
  const diags = collectDiagnostics(phenotype);
  if (diags.length === 0) return;

  const hasErrors = diags.some((d) => d.level === "error");

  for (const d of diags) {
    const msg = `[${d.code}] ${d.message}`;
    if (d.level === "error") {
      display.rustStyleError({ code: d.code, message: d.message, file: filePath });
    } else if (d.level === "warning") {
      display.warn(msg);
    } else {
      display.info(msg);
    }
  }

  if (hasErrors) {
    process.exit(1);
  }
}
