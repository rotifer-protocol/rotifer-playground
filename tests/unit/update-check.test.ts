import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("update-check", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-uc-test-" + randomUUID());
    mkdirSync(configDir, { recursive: true });
    vi.stubEnv("ROTIFER_CONFIG_DIR", configDir);
    vi.stubEnv("npm_execpath", "");
    vi.stubEnv("npm_command", "");
    delete process.env.CI;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.ROTIFER_NO_UPDATE_CHECK;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("returns null when CI env is set", async () => {
    vi.stubEnv("CI", "true");
    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).toBeNull();
  });

  it("returns null when NO_UPDATE_NOTIFIER is set", async () => {
    vi.stubEnv("NO_UPDATE_NOTIFIER", "1");
    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).toBeNull();
  });

  it("returns null when ROTIFER_NO_UPDATE_CHECK is set", async () => {
    vi.stubEnv("ROTIFER_NO_UPDATE_CHECK", "1");
    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).toBeNull();
  });

  it("detects major upgrade correctly", async () => {
    const mod = await import("../../src/utils/update-check.js");
    expect(mod.isMajorUpgrade("0.8.0", "1.0.0")).toBe(true);
    expect(mod.isMajorUpgrade("0.8.0", "0.9.0")).toBe(false);
    expect(mod.isMajorUpgrade("1.0.0", "2.0.0")).toBe(true);
    expect(mod.isMajorUpgrade("1.0.0", "1.1.0")).toBe(false);
  });

  it("returns update info when cache has newer version", async () => {
    writeFileSync(join(configDir, "update-check.json"), JSON.stringify({
      "@rotifer/playground": { lastCheck: Date.now(), latest: "0.9.0" },
    }));

    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).not.toBeNull();
    expect(result!.current).toBe("0.8.0");
    expect(result!.latest).toBe("0.9.0");
    expect(result!.isMajor).toBe(false);
  });

  it("returns null when cache shows same version", async () => {
    writeFileSync(join(configDir, "update-check.json"), JSON.stringify({
      "@rotifer/playground": { lastCheck: Date.now(), latest: "0.8.0" },
    }));

    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).toBeNull();
  });

  it("handles corrupt cache and falls back to fetch", async () => {
    writeFileSync(join(configDir, "update-check.json"), "NOT VALID JSON {{{");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "0.9.0" }), { status: 200 }),
    );

    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).not.toBeNull();
    expect(result!.latest).toBe("0.9.0");
  });

  it("returns null when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const mod = await import("../../src/utils/update-check.js");
    const result = await mod.checkForUpdate("@rotifer/playground", "0.8.0");
    expect(result).toBeNull();
  });

  it("checkCacheSync returns update info from fresh cache", async () => {
    writeFileSync(join(configDir, "update-check.json"), JSON.stringify({
      "@rotifer/playground": { lastCheck: Date.now(), latest: "2.0.0" },
    }));

    const mod = await import("../../src/utils/update-check.js");
    const result = mod.checkCacheSync("@rotifer/playground", "0.8.0");
    expect(result).not.toBeNull();
    expect(result!.latest).toBe("2.0.0");
    expect(result!.isMajor).toBe(true);
  });

  it("checkCacheSync returns update info even for stale cache", async () => {
    writeFileSync(join(configDir, "update-check.json"), JSON.stringify({
      "@rotifer/playground": { lastCheck: 0, latest: "2.0.0" },
    }));

    const mod = await import("../../src/utils/update-check.js");
    const result = mod.checkCacheSync("@rotifer/playground", "0.8.0");
    expect(result).not.toBeNull();
    expect(result!.latest).toBe("2.0.0");
  });

  it("checkCacheSync returns null when no update", async () => {
    writeFileSync(join(configDir, "update-check.json"), JSON.stringify({
      "@rotifer/playground": { lastCheck: Date.now(), latest: "0.8.0" },
    }));

    const mod = await import("../../src/utils/update-check.js");
    const result = mod.checkCacheSync("@rotifer/playground", "0.8.0");
    expect(result).toBeNull();
  });
});
