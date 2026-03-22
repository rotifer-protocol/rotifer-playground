import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";

describe("Security: credential file permissions", () => {
  const realCredPath = join(homedir(), ".rotifer", "credentials.json");

  it("credentials.json in ~/.rotifer is not world-readable (if it exists)", () => {
    if (!existsSync(realCredPath)) {
      return;
    }
    const stats = statSync(realCredPath);
    const mode = stats.mode & 0o777;
    const worldRead = mode & 0o004;
    const worldWrite = mode & 0o002;
    expect(worldRead).toBe(0);
    expect(worldWrite).toBe(0);
  });

  it("~/.rotifer directory is not world-accessible (if it exists)", () => {
    const rotiferDir = join(homedir(), ".rotifer");
    if (!existsSync(rotiferDir)) {
      return;
    }
    const stats = statSync(rotiferDir);
    const mode = stats.mode & 0o777;
    const worldRead = mode & 0o004;
    const worldExec = mode & 0o001;
    expect(worldRead).toBe(0);
    expect(worldExec).toBe(0);
  });

  it("credentials.json is valid JSON if it exists", () => {
    if (!existsSync(realCredPath)) {
      return;
    }
    const { readFileSync } = require("node:fs");
    const content = readFileSync(realCredPath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("credential file does not contain plaintext passwords", () => {
    if (!existsSync(realCredPath)) {
      return;
    }
    const { readFileSync } = require("node:fs");
    const content = readFileSync(realCredPath, "utf-8");
    expect(content).not.toMatch(/"password"\s*:/i);
  });
});
