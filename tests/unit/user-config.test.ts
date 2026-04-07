import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("user-config", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-ucfg-test-" + randomUUID());
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

  it("isValidKey accepts known keys and rejects unknown", async () => {
    const mod = await import("../../src/utils/user-config.js");
    expect(mod.isValidKey("update-check")).toBe(true);
    expect(mod.isValidKey("last-version")).toBe(true);
    expect(mod.isValidKey("unknown-key")).toBe(false);
  });

  it("loadUserConfig returns empty object when no file exists", async () => {
    const mod = await import("../../src/utils/user-config.js");
    const config = mod.loadUserConfig();
    expect(config).toEqual({});
  });

  it("saves and loads config correctly", async () => {
    const mod = await import("../../src/utils/user-config.js");
    mod.saveUserConfig({ "update-check": false, "last-version": "0.7.0" });
    const loaded = mod.loadUserConfig();
    expect(loaded["update-check"]).toBe(false);
    expect(loaded["last-version"]).toBe("0.7.0");
  });

  it("getUserConfigValue returns default for unset keys", async () => {
    const mod = await import("../../src/utils/user-config.js");
    expect(mod.getUserConfigValue("update-check")).toBe("true");
  });

  it("setUserConfigValue correctly parses boolean for update-check", async () => {
    const mod = await import("../../src/utils/user-config.js");
    mod.setUserConfigValue("update-check", "false");
    expect(mod.loadUserConfig()["update-check"]).toBe(false);

    mod.setUserConfigValue("update-check", "true");
    expect(mod.loadUserConfig()["update-check"]).toBe(true);
  });
});
