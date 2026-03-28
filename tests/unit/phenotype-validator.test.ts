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
});
