import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  autoPublishGate,
  needsCompileBeforePublish,
  skipHintFor,
  type AutoPublishGateInput,
} from "../../src/publish/auto-publish.js";

/**
 * ADR-247 R3 is "prompt, default Y" — not "upload silently". Each skip below
 * is a case where a default of Y would publish something nobody agreed to, or
 * would fail in a way the prompt cannot help with. They are asserted
 * individually rather than through the happy path so that deleting any one
 * check turns exactly one test red.
 */

const ALLOWED: AutoPublishGateInput = {
  enabled: true,
  interactive: true,
  loggedIn: true,
  needsWasm: false,
};

describe("autoPublishGate", () => {
  it("offers when the knob is on, a human is present, and the gene is publishable", () => {
    expect(autoPublishGate(ALLOWED)).toEqual({ offer: true });
  });

  it("does not offer when the user turned default-publish off", () => {
    expect(autoPublishGate({ ...ALLOWED, enabled: false })).toEqual({
      offer: false,
      reason: "disabled-by-config",
    });
  });

  it("does not offer without a TTY — a default of Y in CI is an unattended upload", () => {
    expect(autoPublishGate({ ...ALLOWED, interactive: false })).toEqual({
      offer: false,
      reason: "non-interactive",
    });
  });

  it("does not offer a Native gene that has not been compiled", () => {
    expect(autoPublishGate({ ...ALLOWED, needsWasm: true })).toEqual({
      offer: false,
      reason: "needs-compile",
    });
  });

  it("does not offer when signed out — publish would reject it anyway", () => {
    expect(autoPublishGate({ ...ALLOWED, loggedIn: false })).toEqual({
      offer: false,
      reason: "not-logged-in",
    });
  });

  it("reports the opt-out first, so an explicit 'off' is never second-guessed", () => {
    const everythingWrong: AutoPublishGateInput = {
      enabled: false,
      interactive: false,
      loggedIn: false,
      needsWasm: true,
    };
    expect(autoPublishGate(everythingWrong).reason).toBe("disabled-by-config");
  });

  it("reports needs-compile ahead of not-logged-in — logging in would not help", () => {
    expect(autoPublishGate({ ...ALLOWED, needsWasm: true, loggedIn: false }).reason).toBe(
      "needs-compile",
    );
  });
});

/**
 * Only `non-interactive` is reachable from tests/e2e/wrap-auto-publish.test.ts
 * — a spawned CLI has no TTY, so that reason shadows the rest. These assert the
 * three messages a user actually hits at a terminal.
 */
describe("skipHintFor", () => {
  it("sends an uncompiled Native gene to compile, not to publish", () => {
    const hint = skipHintFor("needs-compile", "my-gene");
    expect(hint).toContain("rotifer compile my-gene");
    expect(hint).not.toContain("rotifer publish");
  });

  it("sends a signed-out user to login, with publish as the follow-up", () => {
    const hint = skipHintFor("not-logged-in", "my-gene");
    expect(hint).toContain("rotifer login");
    expect(hint).toContain("rotifer publish my-gene");
  });

  it("keeps the plain publish hint for an opt-out — turning off the prompt does not hide the command", () => {
    expect(skipHintFor("disabled-by-config", "my-gene")).toContain("rotifer publish my-gene");
  });

  it("keeps the plain publish hint in CI", () => {
    expect(skipHintFor("non-interactive", "my-gene")).toContain("rotifer publish my-gene");
  });
});

describe("needsCompileBeforePublish", () => {
  let geneDir: string;

  beforeEach(() => {
    geneDir = join(tmpdir(), `rotifer-autopub-${randomUUID()}`);
    mkdirSync(geneDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(geneDir, { recursive: true, force: true });
  });

  it("is true for a Native gene with no gene.ir.wasm", () => {
    expect(needsCompileBeforePublish(geneDir, "Native")).toBe(true);
  });

  it("is false once gene.ir.wasm exists", () => {
    writeFileSync(join(geneDir, "gene.ir.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    expect(needsCompileBeforePublish(geneDir, "Native")).toBe(false);
  });

  it("is false for Wrapped and Hybrid, which publish without WASM", () => {
    expect(needsCompileBeforePublish(geneDir, "Wrapped")).toBe(false);
    expect(needsCompileBeforePublish(geneDir, "Hybrid")).toBe(false);
  });
});
