import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";

describe("Security: credential file permissions", () => {
  const realCredPath = join(homedir(), ".rotifer", "credentials.json");
  const rotiferDir = join(homedir(), ".rotifer");
  // These inspect this machine's own files. Where there are none (a CI runner,
  // a fresh checkout) there is nothing to check, and the run says "skipped"
  // rather than reporting a pass that checked nothing.
  const hasCredFile = existsSync(realCredPath);

  it.skipIf(!hasCredFile)("credentials.json in ~/.rotifer is not world-readable", () => {
    const stats = statSync(realCredPath);
    const mode = stats.mode & 0o777;
    const worldRead = mode & 0o004;
    const worldWrite = mode & 0o002;
    expect(worldRead).toBe(0);
    expect(worldWrite).toBe(0);
  });

  it.skipIf(!existsSync(rotiferDir))("~/.rotifer directory is not world-accessible", () => {
    const stats = statSync(rotiferDir);
    const mode = stats.mode & 0o777;
    const worldRead = mode & 0o004;
    const worldExec = mode & 0o001;
    expect(worldRead).toBe(0);
    expect(worldExec).toBe(0);
  });

  it.skipIf(!hasCredFile)("credentials.json is valid JSON", () => {
    const { readFileSync } = require("node:fs");
    const content = readFileSync(realCredPath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it.skipIf(!hasCredFile)("credential file does not contain plaintext passwords", () => {
    const { readFileSync } = require("node:fs");
    const content = readFileSync(realCredPath, "utf-8");
    expect(content).not.toMatch(/"password"\s*:/i);
  });
});
