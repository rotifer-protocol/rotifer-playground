import * as display from "./display.js";
import {
  EXECUTION_MODELS,
  GUARD_POSITIONS,
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
    if (!llm.templateFormat || !VALID_TEMPLATE_FORMATS.includes(llm.templateFormat as string)) {
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
    if (!guard.position || !VALID_GUARD_POSITIONS.includes(guard.position as string)) {
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
  if (sm !== undefined && !VALID_SYNTHESIS_METHODS.includes(sm)) {
    diags.push({
      level: "error",
      code: "E0090",
      message: `synthesisMethod must be one of: ${VALID_SYNTHESIS_METHODS.join(", ")} (got '${sm}')`,
    });
  }

  // v0.9.1 §3.3: executionModel enum validation.
  const em = phenotype.executionModel as string | undefined;
  if (em !== undefined && !VALID_EXECUTION_MODELS.includes(em)) {
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
