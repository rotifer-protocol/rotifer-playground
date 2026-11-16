import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The extension's out-of-the-box Cloud key is the `rotifer.anonKey` default in package.json.
// Rotifer Cloud has disabled legacy JWT keys (`eyJ…`): with one, every Cloud call, including
// the sign-in token exchange, gets 401 "Legacy API keys are disabled".

const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const defaultKey: string = manifest.contributes.configuration.properties["rotifer.anonKey"].default;

describe("default rotifer.anonKey", () => {
  it("is a publishable key, not a legacy JWT key", () => {
    expect(defaultKey.startsWith("eyJ")).toBe(false);
    expect(defaultKey.startsWith("sb_publishable_")).toBe(true);
  });

  it("is the same key the CLI ships", () => {
    const cliTypes = readFileSync(join(__dirname, "../../../src/cloud/types.ts"), "utf-8");
    const cliKey = cliTypes.match(/export const DEFAULT_CLOUD_ANON_KEY = "([^"]+)"/)?.[1];
    expect(cliKey).toBeDefined();
    expect(defaultKey).toBe(cliKey);
  });
});
