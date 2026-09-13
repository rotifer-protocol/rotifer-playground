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

// ─── security/correctness regression: per-package version comparison ────────
//
// Every package used to be checked against *this CLI's* version. Because the
// two packages version independently, @rotifer/mcp-server's real releases
// (0.17.0, 0.18.0) were compared against playground's higher number, judged
// older, and silently skipped — the mcp-server half of `self-update` had never
// actually updated anything. Revert resolveUpdateTargets to passing
// `ownVersion` for both packages and the first test here goes red.

describe("self-update — parseVersionOutput", () => {
  it("reads a bare version", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.parseVersionOutput("0.18.0\n")).toBe("0.18.0");
  });

  it("reads the version even when an update banner follows it", async () => {
    const mod = await import("../../src/commands/self-update.js");
    const out = "0.9.0\n\n──────────\n  Update available: 0.9.0 → 0.24.0\n──────────\n";
    expect(mod.parseVersionOutput(out)).toBe("0.9.0");
  });

  it("reads a prerelease version", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.parseVersionOutput("1.2.3-beta.4")).toBe("1.2.3-beta.4");
  });

  it("returns null when there is no version in the output", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.parseVersionOutput("command not found")).toBeNull();
  });
});

describe("self-update — getInstalledVersion", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.restoreAllMocks();
  });

  it("answers for the CLI's own package without spawning anything", async () => {
    const execFileSync = vi.fn(() => {
      throw new Error("must not spawn for the CLI's own package");
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.getInstalledVersion(mod.OWN_PACKAGE, "0.24.0")).toBe("0.24.0");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("asks the installed binary, not this CLI, for another package's version", async () => {
    const execFileSync = vi.fn(() => "0.18.0\n");
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const mod = await import("../../src/commands/self-update.js");

    expect(mod.getInstalledVersion("@rotifer/mcp-server", "0.24.0")).toBe("0.18.0");
    // Control: prove the probe really ran, so a null/short-circuit can never
    // masquerade as a pass.
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0][0]).toBe("rotifer-mcp-server");
    expect(execFileSync.mock.calls[0][1]).toEqual(["--version"]);
  });

  it("reports a package with no binary on PATH as not installed", async () => {
    const execFileSync = vi.fn(() => {
      throw Object.assign(new Error("spawn rotifer-mcp-server ENOENT"), { code: "ENOENT" });
    });
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.getInstalledVersion("@rotifer/mcp-server", "0.24.0")).toBeNull();
  });

  it("returns null for a package it has no binary mapping for", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.getInstalledVersion("@rotifer/nope", "0.24.0")).toBeNull();
  });
});

describe("self-update — resolveUpdateTargets", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../src/utils/update-check.js");
    vi.restoreAllMocks();
  });

  it("compares each package against its OWN installed version", async () => {
    vi.doMock("node:child_process", () => ({ execFileSync: () => "0.18.0\n" }));
    const checkForUpdate = vi.fn(async () => null);
    vi.doMock("../../src/utils/update-check.js", () => ({ checkForUpdate }));

    const mod = await import("../../src/commands/self-update.js");
    await mod.resolveUpdateTargets("0.24.0");

    const asked = Object.fromEntries(checkForUpdate.mock.calls.map((c: unknown[]) => [c[0], c[1]]));
    expect(asked["@rotifer/playground"]).toBe("0.24.0");
    // The regression: this used to be "0.24.0" too, so mcp-server@0.18.0 was
    // judged already-newer-than-latest and never offered.
    expect(asked["@rotifer/mcp-server"]).toBe("0.18.0");
  });

  it("does not offer to install a package that is not installed", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: () => { throw new Error("ENOENT"); },
    }));
    const checkForUpdate = vi.fn(async () => ({ current: "0.1.0", latest: "9.9.9", isMajor: true }));
    vi.doMock("../../src/utils/update-check.js", () => ({ checkForUpdate }));

    const mod = await import("../../src/commands/self-update.js");
    const targets = await mod.resolveUpdateTargets("0.24.0");

    const mcp = targets.find((t: { name: string }) => t.name === "@rotifer/mcp-server");
    expect(mcp?.installed).toBeNull();
    expect(mcp?.info).toBeNull();
    expect(checkForUpdate).not.toHaveBeenCalledWith("@rotifer/mcp-server", expect.anything());
  });
});

describe("self-update — readRollbackTargets", () => {
  it("rolls back every package recorded by the last update", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(
      mod.readRollbackTargets({
        "last-versions": { "@rotifer/playground": "0.23.2", "@rotifer/mcp-server": "0.17.0" },
      }),
    ).toEqual({ "@rotifer/playground": "0.23.2", "@rotifer/mcp-server": "0.17.0" });
  });

  it("still understands a config written by an older CLI", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.readRollbackTargets({ "last-version": "0.23.2" })).toEqual({
      "@rotifer/playground": "0.23.2",
    });
  });

  it("has nothing to roll back on a fresh config", async () => {
    const mod = await import("../../src/commands/self-update.js");
    expect(mod.readRollbackTargets({})).toEqual({});
  });
});
