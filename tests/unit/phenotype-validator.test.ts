import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/display.js", () => ({
  rustStyleError: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

import { validateLlmNativePhenotype } from "../../src/utils/phenotype-validator.js";
import * as display from "../../src/utils/display.js";

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
});

function basePhenotype(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-gene",
    domain: "code.test",
    fidelity: "Wrapped",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    ...overrides,
  };
}

describe("validateLlmNativePhenotype", () => {
  describe("clean phenotype", () => {
    it("does not warn or error for a basic valid phenotype", () => {
      validateLlmNativePhenotype(basePhenotype(), "test.json");
      expect(display.rustStyleError).not.toHaveBeenCalled();
      expect(display.warn).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("llmRequirements validation", () => {
    it("warns for invalid templateFormat", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "prompt.chat",
          llmRequirements: {
            templateFormat: "invalid",
            templateVariables: ["text"],
          },
        }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(
        expect.stringContaining("W0080"),
      );
    });

    it("accepts valid templateFormat values", () => {
      for (const fmt of ["mustache", "handlebars", "jinja2", "fstring", "raw"]) {
        vi.clearAllMocks();
        validateLlmNativePhenotype(
          basePhenotype({
            domain: "prompt.chat",
            llmRequirements: {
              templateFormat: fmt,
              templateVariables: ["text"],
            },
          }),
          "test.json",
        );
        const warnCalls = vi.mocked(display.warn).mock.calls.filter(
          ([msg]) => msg.includes("W0080"),
        );
        expect(warnCalls).toHaveLength(0);
      }
    });

    it("errors when templateVariables is empty", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "prompt.chat",
          llmRequirements: {
            templateFormat: "mustache",
            templateVariables: [],
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0080" }),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("errors when templateVariables is missing", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "prompt.chat",
          llmRequirements: { templateFormat: "mustache" },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0080" }),
      );
    });

    it("errors when templateVariable references non-existent inputSchema property", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "prompt.chat",
          llmRequirements: {
            templateFormat: "mustache",
            templateVariables: ["nonexistent"],
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0081" }),
      );
    });

    it("passes when templateVariable exists in inputSchema", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "prompt.chat",
          llmRequirements: {
            templateFormat: "mustache",
            templateVariables: ["text"],
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("warns when llmRequirements is on non-prompt domain", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "code.test",
          llmRequirements: {
            templateFormat: "mustache",
            templateVariables: ["text"],
          },
        }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(
        expect.stringContaining("W0081"),
      );
    });
  });

  describe("guardConfig validation", () => {
    it("errors for invalid guard position", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "guard.safety",
          guardConfig: {
            position: "invalid",
            categories: ["toxicity"],
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0082" }),
      );
    });

    it("accepts valid guard positions", () => {
      for (const pos of ["input", "output", "both"]) {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
        validateLlmNativePhenotype(
          basePhenotype({
            domain: "guard.safety",
            guardConfig: {
              position: pos,
              categories: ["toxicity"],
            },
          }),
          "test.json",
        );
        const errorCalls = vi.mocked(display.rustStyleError).mock.calls.filter(
          ([obj]) => (obj as any).code === "E0082",
        );
        expect(errorCalls).toHaveLength(0);
      }
    });

    it("errors when categories is empty", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "guard.safety",
          guardConfig: { position: "input", categories: [] },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0083" }),
      );
    });

    it("errors when riskThreshold is out of range (> 1)", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "guard.safety",
          guardConfig: { position: "input", categories: ["toxicity"], riskThreshold: 1.5 },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0084" }),
      );
    });

    it("errors when riskThreshold is negative", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "guard.safety",
          guardConfig: { position: "input", categories: ["toxicity"], riskThreshold: -0.1 },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0084" }),
      );
    });

    it("accepts valid riskThreshold", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "guard.safety",
          guardConfig: { position: "input", categories: ["toxicity"], riskThreshold: 0.7 },
        }),
        "test.json",
      );
      const errorCalls = vi.mocked(display.rustStyleError).mock.calls.filter(
        ([obj]) => (obj as any).code === "E0084",
      );
      expect(errorCalls).toHaveLength(0);
    });

    it("warns when guardConfig is on non-guard domain", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "code.test",
          guardConfig: { position: "input", categories: ["toxicity"] },
        }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(
        expect.stringContaining("W0082"),
      );
    });
  });

  describe("cross-cutting concerns", () => {
    it("warns when prompt domain gene has Native fidelity", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          domain: "prompt.chat",
          fidelity: "Native",
        }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(
        expect.stringContaining("W0083"),
      );
    });

    it("shows info when guard domain gene is missing guardConfig", () => {
      validateLlmNativePhenotype(
        basePhenotype({ domain: "guard.safety" }),
        "test.json",
      );
      expect(display.info).toHaveBeenCalledWith(
        expect.stringContaining("I0080"),
      );
    });

    it("does not exit when only warnings are present", () => {
      validateLlmNativePhenotype(
        basePhenotype({ domain: "prompt.chat", fidelity: "Native" }),
        "test.json",
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ─── v0.9.1 §3.3: executionModel + systemPrompt ────────────────────────────

  describe("executionModel validation (v0.9.1 §3.3)", () => {
    it("accepts CHAT / BATCH / EVENT_DRIVEN", () => {
      for (const em of ["CHAT", "BATCH", "EVENT_DRIVEN"]) {
        validateLlmNativePhenotype(
          basePhenotype({
            executionModel: em,
            description: "A sufficiently long description for chat Agents.",
          }),
          "test.json",
        );
      }
      expect(display.rustStyleError).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0100" }),
      );
    });

    it("errors on unknown executionModel value", () => {
      validateLlmNativePhenotype(
        basePhenotype({ executionModel: "STREAMING" }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0100" }),
      );
      expect(exitSpy).toHaveBeenCalled();
    });

    it("treats absent executionModel as OK (legacy Gene compat)", () => {
      validateLlmNativePhenotype(basePhenotype(), "test.json");
      expect(display.rustStyleError).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0100" }),
      );
      expect(display.warn).not.toHaveBeenCalledWith(expect.stringContaining("W0100"));
    });

    it("warns when CHAT executionModel has empty description", () => {
      validateLlmNativePhenotype(
        basePhenotype({ executionModel: "CHAT", description: "" }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("W0100"));
    });

    it("warns when CHAT executionModel has too-short description (<10 chars)", () => {
      validateLlmNativePhenotype(
        basePhenotype({ executionModel: "CHAT", description: "Helper." }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("W0100"));
    });

    it("no warning for CHAT with sufficient description", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          executionModel: "CHAT",
          description: "An assistant that drafts weekly status reports.",
        }),
        "test.json",
      );
      expect(display.warn).not.toHaveBeenCalledWith(expect.stringContaining("W0100"));
    });

    it("warns when systemPrompt is set on non-CHAT executionModel", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          executionModel: "BATCH",
          systemPrompt: "You are helpful.",
        }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("W0101"));
    });

    it("no warning when systemPrompt is set with CHAT executionModel", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          executionModel: "CHAT",
          description: "An assistant that helps users.",
          systemPrompt: "You are helpful.",
        }),
        "test.json",
      );
      expect(display.warn).not.toHaveBeenCalledWith(expect.stringContaining("W0101"));
    });
  });

  // ─── v0.9 §3.11 Hybrid Fidelity (spec §4.2 v2.11, ADR-220 D-04) ────────────

  describe("externalDependencies validation (v0.9 §3.11)", () => {
    it("accepts a valid externalDependencies declaration", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          fidelity: "Hybrid",
          externalDependencies: [
            {
              apiType: "rest",
              semanticTag: "cve-database",
              degradationBehavior: "PartialRetry",
            },
          ],
        }),
        "test.json",
      );
      expect(display.rustStyleError).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("errors when externalDependencies is not an array", () => {
      validateLlmNativePhenotype(
        basePhenotype({ externalDependencies: "rest" }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0110" }),
      );
      expect(exitSpy).toHaveBeenCalled();
    });

    it("errors when externalDependencies[i].apiType is missing", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          fidelity: "Hybrid",
          externalDependencies: [
            { semanticTag: "git-cli", degradationBehavior: "FailFast" },
          ],
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0112" }),
      );
    });

    it("errors when externalDependencies[i].semanticTag is missing", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          fidelity: "Hybrid",
          externalDependencies: [
            { apiType: "graphql", degradationBehavior: "SilentDegrade" },
          ],
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0113" }),
      );
    });

    it("errors on unknown degradationBehavior value", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          fidelity: "Hybrid",
          externalDependencies: [
            {
              apiType: "rest",
              semanticTag: "llm-judge",
              degradationBehavior: "retry_then_skip",
            },
          ],
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0114" }),
      );
    });

    it("warns when fidelity='Hybrid' but externalDependencies is missing", () => {
      validateLlmNativePhenotype(
        basePhenotype({ fidelity: "Hybrid" }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("W0110"));
    });

    it("warns case-insensitively for fidelity='hybrid' (Q2=c normalization)", () => {
      validateLlmNativePhenotype(
        basePhenotype({ fidelity: "hybrid" }),
        "test.json",
      );
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("W0110"));
    });

    it("does not warn for fidelity='Native' without externalDependencies", () => {
      validateLlmNativePhenotype(
        basePhenotype({ fidelity: "Native" }),
        "test.json",
      );
      expect(display.warn).not.toHaveBeenCalledWith(expect.stringContaining("W0110"));
    });
  });

  describe("simulationSpec validation (v0.9 §3.11, ADR-220 T1)", () => {
    it("accepts a valid simulationSpec", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          simulationSpec: {
            supportsDryRun: true,
            resourceEstimate: { estimatedLatencyMs: 250 },
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).not.toHaveBeenCalled();
    });

    it("errors when supportsDryRun is not a boolean", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          simulationSpec: {
            supportsDryRun: "yes",
            resourceEstimate: { estimatedLatencyMs: 100 },
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0120" }),
      );
    });

    it("errors when resourceEstimate.estimatedLatencyMs is missing", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          simulationSpec: {
            supportsDryRun: true,
            resourceEstimate: {},
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0122" }),
      );
    });
  });

  describe("degradationSpec validation (v0.9 §3.11, ADR-220 E2)", () => {
    it("accepts a valid degradationSpec", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          degradationSpec: {
            mode: "PARTIAL_OUTPUT",
            minimumDependencies: ["cve-database"],
            fallbackOutputSchema: { type: "object" },
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).not.toHaveBeenCalled();
    });

    it("errors on unknown degradationSpec.mode value", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          degradationSpec: {
            mode: "GRACEFUL",
            minimumDependencies: [],
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0130" }),
      );
    });

    it("errors when minimumDependencies is not an array", () => {
      validateLlmNativePhenotype(
        basePhenotype({
          degradationSpec: {
            mode: "FAIL_FAST",
            minimumDependencies: "cve-database",
          },
        }),
        "test.json",
      );
      expect(display.rustStyleError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E0131" }),
      );
    });
  });

  describe("FIDELITY_DISCOUNT constants (spec §5.1 v2.11)", () => {
    it("exposes the canonical lowercase tier keys", async () => {
      const { FIDELITY_DISCOUNT } = await import("../../src/types/phenotype.js");
      expect(FIDELITY_DISCOUNT.native).toBe(1.0);
      expect(FIDELITY_DISCOUNT.hybrid).toBe(0.85);
      expect(FIDELITY_DISCOUNT.wrapped).toBe(0.7);
    });

    it("is frozen (mutation throws in strict mode)", async () => {
      const { FIDELITY_DISCOUNT } = await import("../../src/types/phenotype.js");
      expect(Object.isFrozen(FIDELITY_DISCOUNT)).toBe(true);
    });
  });
});
