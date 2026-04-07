import { execSync, ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const CLI = "node dist/index.js";
const cwd = join(__dirname, "../..");

let configDir: string;

function run(cmd: string, opts?: Partial<ExecSyncOptionsWithStringEncoding>): string {
  return execSync(`${CLI} ${cmd}`, {
    cwd,
    encoding: "utf-8",
    timeout: 15000,
    env: {
      ...process.env,
      ROTIFER_CONFIG_DIR: configDir,
      NO_UPDATE_NOTIFIER: "1",
      npm_execpath: "",
      npm_command: "",
    },
    ...opts,
  });
}

function runWithStderr(cmd: string): { stdout: string; stderr: string } {
  try {
    const stdout = execSync(`${CLI} ${cmd}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      env: {
        ...process.env,
        ROTIFER_CONFIG_DIR: configDir,
        NO_UPDATE_NOTIFIER: "1",
        npm_execpath: "",
        npm_command: "",
      },
    });
    return { stdout, stderr: "" };
  } catch (err: any) {
    return { stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

describe("rotifer self-update", () => {
  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-e2e-su-" + randomUUID());
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("shows help with --help", () => {
    const out = run("self-update --help");
    expect(out).toContain("Check for updates");
    expect(out).toContain("--rollback");
  });

  it("shows 'up to date' when cache has current version", () => {
    const currentVersion = execSync(
      "node -e \"process.stdout.write(require('./package.json').version)\"",
      { cwd, encoding: "utf-8" },
    );
    writeFileSync(join(configDir, "update-check.json"), JSON.stringify({
      "@rotifer/playground": { lastCheck: Date.now(), latest: currentVersion },
      "@rotifer/mcp-server": { lastCheck: Date.now(), latest: currentVersion },
    }));

    const out = run("self-update");
    expect(out).toContain("up to date");
  });

  it("rollback fails with no previous version recorded", () => {
    const { stderr } = runWithStderr("self-update --rollback");
    expect(stderr).toContain("No previous version recorded");
  });
});

describe("rotifer config", () => {
  beforeEach(() => {
    configDir = join(tmpdir(), "rotifer-e2e-cfg-" + randomUUID());
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("shows help with --help", () => {
    const out = run("config --help");
    expect(out).toContain("Manage global Rotifer configuration");
    expect(out).toContain("get");
    expect(out).toContain("set");
    expect(out).toContain("list");
  });

  it("config get returns default for update-check", () => {
    const out = run("config get update-check");
    expect(out).toContain("update-check");
    expect(out).toContain("true");
  });

  it("config set then get roundtrip", () => {
    run("config set update-check false");
    const out = run("config get update-check");
    expect(out).toContain("update-check");
    expect(out).toContain("false");
  });

  it("config set then list shows value", () => {
    run("config set update-check false");
    const out = run("config list");
    expect(out).toContain("update-check");
    expect(out).toContain("false");
  });

  it("config list shows defaults when empty", () => {
    const out = run("config list");
    expect(out).toContain("No configuration set");
  });

  it("config get rejects unknown key", () => {
    const { stderr } = runWithStderr("config get bad-key");
    expect(stderr).toContain("Unknown config key");
  });

  it("config set rejects unknown key", () => {
    const { stderr } = runWithStderr("config set bad-key value");
    expect(stderr).toContain("Unknown config key");
  });
});
