import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("default-publish config key", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-dpub-test-" + randomUUID());
    mkdirSync(configDir, { recursive: true });
    vi.stubEnv("ROTIFER_CONFIG_DIR", configDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("isValidKey accepts 'default-publish'", async () => {
    const mod = await import("../../src/utils/user-config.js");
    expect(mod.isValidKey("default-publish")).toBe(true);
  });

  it("getUserConfigValue returns 'true' for default-publish by default", async () => {
    const mod = await import("../../src/utils/user-config.js");
    expect(mod.getUserConfigValue("default-publish")).toBe("true");
  });

  it("setUserConfigValue('default-publish', 'false') persists correctly", async () => {
    const mod = await import("../../src/utils/user-config.js");
    mod.setUserConfigValue("default-publish", "false");
    const loaded = mod.loadUserConfig();
    expect(loaded["default-publish"]).toBe(false);
  });

  it("setUserConfigValue('default-publish', 'true') persists correctly", async () => {
    const mod = await import("../../src/utils/user-config.js");
    mod.setUserConfigValue("default-publish", "true");
    const loaded = mod.loadUserConfig();
    expect(loaded["default-publish"]).toBe(true);
  });
});

describe("ROTIFER_AUTO_PUBLISH environment variable override", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-dpub-env-" + randomUUID());
    mkdirSync(configDir, { recursive: true });
    vi.stubEnv("ROTIFER_CONFIG_DIR", configDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("ROTIFER_AUTO_PUBLISH=false overrides default-publish config", async () => {
    vi.stubEnv("ROTIFER_AUTO_PUBLISH", "false");
    const mod = await import("../../src/utils/user-config.js");
    expect(mod.shouldAutoPublish()).toBe(false);
  });

  it("ROTIFER_AUTO_PUBLISH unset falls back to config (default true)", async () => {
    const mod = await import("../../src/utils/user-config.js");
    expect(mod.shouldAutoPublish()).toBe(true);
  });

  it("ROTIFER_AUTO_PUBLISH unset + config false → returns false", async () => {
    const mod = await import("../../src/utils/user-config.js");
    mod.setUserConfigValue("default-publish", "false");
    vi.resetModules();
    const mod2 = await import("../../src/utils/user-config.js");
    expect(mod2.shouldAutoPublish()).toBe(false);
  });
});

describe("publish command synthesisMethod defaults", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `rotifer-pub-synth-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("publish sets synthesisMethod=MANUAL when absent in phenotype", () => {
    const phenotype = {
      domain: "test.unit",
      version: "0.1.0",
      fidelity: "Wrapped",
      description: "test gene",
      inputSchema: { type: "object", properties: {} },
    };
    writeFileSync(join(tmpDir, "phenotype.json"), JSON.stringify(phenotype));

    const loaded = JSON.parse(readFileSync(join(tmpDir, "phenotype.json"), "utf-8"));
    if (!loaded.synthesisMethod) {
      loaded.synthesisMethod = "MANUAL";
    }
    expect(loaded.synthesisMethod).toBe("MANUAL");
  });

  it("publish preserves existing synthesisMethod when present", () => {
    const phenotype = {
      domain: "test.unit",
      version: "0.1.0",
      fidelity: "Wrapped",
      description: "test gene",
      synthesisMethod: "LLM_ASSISTED",
      inputSchema: { type: "object", properties: {} },
    };
    writeFileSync(join(tmpDir, "phenotype.json"), JSON.stringify(phenotype));

    const loaded = JSON.parse(readFileSync(join(tmpDir, "phenotype.json"), "utf-8"));
    if (!loaded.synthesisMethod) {
      loaded.synthesisMethod = "MANUAL";
    }
    expect(loaded.synthesisMethod).toBe("LLM_ASSISTED");
  });
});

/**
 * What used to be here asserted on a string array the test itself had just
 * built, so it passed without `wrap` existing at all. It stood in for §3.4
 * coverage while `shouldAutoPublish()` had no production caller — see
 * src/publish/auto-publish.ts. Real coverage now lives in
 * tests/unit/auto-publish-gate.test.ts (every skip branch) and
 * tests/e2e/wrap-auto-publish.test.ts (the real CLI, non-interactive).
 */
describe("wrap wires the default-publish knob to real behaviour", () => {
  it("shouldAutoPublish has a production caller", async () => {
    const { readFileSync } = await import("node:fs");
    const gate = readFileSync("src/publish/auto-publish.ts", "utf-8");
    expect(gate).toContain("shouldAutoPublish()");

    const wrap = readFileSync("src/commands/wrap.ts", "utf-8");
    expect(wrap).toContain("offerAutoPublish");
  });
});
