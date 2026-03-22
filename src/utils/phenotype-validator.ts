import * as display from "./display.js";

const VALID_TEMPLATE_FORMATS = ["mustache", "handlebars", "jinja2", "fstring", "raw"];
const VALID_GUARD_POSITIONS = ["input", "output", "both"];

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
