import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("self-update — detectPackageManager", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("detects npm when no user agent is set", async () => {
    vi.stubEnv("npm_config_user_agent", "");
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.detectPackageManager()).toBe("npm");
  });

  it("detects pnpm from user agent", async () => {
    vi.stubEnv("npm_config_user_agent", "pnpm/9.1.0 npm/? node/v22.0.0");
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.detectPackageManager()).toBe("pnpm");
  });

  it("detects yarn from user agent", async () => {
    vi.stubEnv("npm_config_user_agent", "yarn/1.22.0 npm/? node/v22.0.0");
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.detectPackageManager()).toBe("yarn");
  });

  it("detects bun from user agent", async () => {
    vi.stubEnv("npm_config_user_agent", "bun/1.0.0 npm/? node/v22.0.0");
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.detectPackageManager()).toBe("bun");
  });

  it("falls back to npm for unknown user agent", async () => {
    vi.stubEnv("npm_config_user_agent", "unknown-pm/1.0.0");
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.detectPackageManager()).toBe("npm");
  });
});

describe("self-update — getInstallCommand", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("generates npm install command", async () => {
    const mod = await import("../../src/commands/self-update.js");
    const [cmd, args] = mod.getInstallCommand("npm", "@rotifer/playground", "0.9.0");
    expect(cmd).toBe("npm");
    expect(args).toEqual(["install", "-g", "@rotifer/playground@0.9.0"]);
  });

  it("generates pnpm add command", async () => {
    const mod = await import("../../src/commands/self-update.js");
    const [cmd, args] = mod.getInstallCommand("pnpm", "@rotifer/playground", "0.9.0");
    expect(cmd).toBe("pnpm");
    expect(args).toEqual(["add", "-g", "@rotifer/playground@0.9.0"]);
  });

  it("generates yarn global add command", async () => {
    const mod = await import("../../src/commands/self-update.js");
    const [cmd, args] = mod.getInstallCommand("yarn", "@rotifer/mcp-server", "1.0.0");
    expect(cmd).toBe("yarn");
    expect(args).toEqual(["global", "add", "@rotifer/mcp-server@1.0.0"]);
  });

  it("generates bun add command", async () => {
    const mod = await import("../../src/commands/self-update.js");
    const [cmd, args] = mod.getInstallCommand("bun", "@rotifer/playground", "0.9.0");
    expect(cmd).toBe("bun");
    expect(args).toEqual(["add", "-g", "@rotifer/playground@0.9.0"]);
  });
});

describe("self-update — verifyProvenance", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns true when attestations exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ dist: { attestations: { signatures: [] } } }), { status: 200 }),
    );
    const mod = await import("../../src/commands/self-update.js");
    const result = await mod.verifyProvenance("@rotifer/playground", "0.9.0");
    expect(result).toBe(true);
  });

  it("returns false when no attestations", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ dist: { tarball: "https://..." } }), { status: 200 }),
    );
    const mod = await import("../../src/commands/self-update.js");
    const result = await mod.verifyProvenance("@rotifer/playground", "0.9.0");
    expect(result).toBe(false);
  });

  it("returns false when registry returns 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    const mod = await import("../../src/commands/self-update.js");
    const result = await mod.verifyProvenance("@rotifer/playground", "99.0.0");
    expect(result).toBe(false);
  });

  it("returns false when network fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
    const mod = await import("../../src/commands/self-update.js");
    const result = await mod.verifyProvenance("@rotifer/playground", "0.9.0");
    expect(result).toBe(false);
  });
});

describe("self-update — PACKAGES constant", () => {
  it("includes both CLI and MCP Server", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.PACKAGES).toContain("@rotifer/playground");
    expect(mod.PACKAGES).toContain("@rotifer/mcp-server");
    expect(mod.PACKAGES).toHaveLength(2);
  });
});

describe("self-update — rollback config", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-su-test-" + randomUUID());
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

  it("saveUserConfig persists last-version for rollback", async () => {
    const mod = await import("../../src/utils/user-config.js");
    mod.saveUserConfig({ "last-version": "0.8.0" });
    const loaded = mod.loadUserConfig();
    expect(loaded["last-version"]).toBe("0.8.0");
  });

  it("loadUserConfig returns undefined last-version when not set", async () => {
    const mod = await import("../../src/utils/user-config.js");
    const config = mod.loadUserConfig();
    expect(config["last-version"]).toBeUndefined();
  });
});
