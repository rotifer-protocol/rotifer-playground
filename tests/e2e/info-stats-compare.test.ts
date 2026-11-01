import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startRecordedCloud, type RecordedCloud } from "./recorded-cloud.js";

const CLI = "node dist/index.js";
const HOME = mkdtempSync(join(tmpdir(), "rotifer-info-stats-home-"));
// `info` and `stats` look genes up in the registry: the recorded one
// (tests/fixtures/cloud/).
let cloud: RecordedCloud;
const run = (cmd: string) =>
  execSync(`${CLI} ${cmd}`, {
    cwd: __dirname + "/../..",
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, HOME, NO_COLOR: "1", ROTIFER_CLOUD_ENDPOINT: cloud.endpoint },
  });

beforeAll(async () => {
  cloud = await startRecordedCloud();
});

afterAll(async () => {
  // Stop the server first, so a failed check cannot leave it running.
  const unrecorded = await cloud.unrecorded();
  await cloud.close();
  expect(unrecorded).toEqual([]);
  rmSync(HOME, { recursive: true, force: true });
});

const tryRun = (cmd: string) => {
  try {
    return run(cmd);
  } catch (err: any) {
    return err.stderr || err.stdout || err.message;
  }
};

describe("rotifer info", () => {
  it("shows help with --help", () => {
    const out = run("info --help");
    expect(out).toContain("<gene-ref>");
    expect(out).toContain("gene details");
  });

  it("fails gracefully with invalid gene ID", () => {
    const out = tryRun("info nonexistent-id-12345");
    expect(out).toMatch(/not found|error|failed/i);
    expect(out).toContain("Gene 'nonexistent-id-12345' not found");
  });
});

describe("rotifer stats", () => {
  it("shows help with --help", () => {
    const out = run("stats --help");
    expect(out).toContain("<gene-ref>");
    expect(out).toContain("download statistics");
  });

  it("fails gracefully with invalid gene ID", () => {
    const out = tryRun("stats nonexistent-id-12345");
    expect(out).toMatch(/not found|error|failed/i);
    expect(out).toContain("Gene 'nonexistent-id-12345' not found");
  });
});

describe("rotifer compare", () => {
  it("shows help with --help", () => {
    const out = run("compare --help");
    expect(out).toContain("genes");
    expect(out).toContain("Compare");
  });

  it("rejects fewer than 2 IDs", () => {
    const out = tryRun("compare single-id");
    expect(out).toMatch(/provide between 2 and 5 gene refs|error/i);
  });
});
