import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * The root plugin family is also the ClawHub package `rotifer`. Nothing in the
 * release path used to run `clawhub package publish`, so the listing stayed at
 * 0.9.3 (2026-08-18) while the repository moved on to 0.9.12.
 *
 * release-root-plugin-family.yml now publishes on a `root-plugin-v*` tag and
 * dry-runs on pull requests. These tests run the job's own step scripts in
 * bash, with a fake `npx` on PATH that records every call.
 */

const ROOT = join(__dirname, "../..");
const WORKFLOW = join(ROOT, ".github/workflows/release-root-plugin-family.yml");

interface Step { name?: string; run?: string; if?: string }
interface Job { needs?: string | string[]; steps: Step[] }
interface Workflow {
  on: { push: { tags: string[] }; pull_request: { paths: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
}

const wf = yaml.load(readFileSync(WORKFLOW, "utf-8")) as Workflow;
const job = wf.jobs["publish-clawhub"];
const step = (name: string) => job.steps.find((s) => s.name === name)!;
const familyVersion: string = JSON.parse(readFileSync(join(ROOT, "plugin-source/families.json"), "utf-8")).root.version;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "root-plugin-wf-"));
  const fake = join(dir, "npx");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${dir}/npx-calls"\necho '{}'\n`);
  chmodSync(fake, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Substitute the GitHub expressions a step uses, then run it in bash from the repo root. */
function run(script: string, ctx: { event: string; dryInput?: boolean; outputs?: Record<string, string> }) {
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const outputs = ctx.outputs ?? {};
  const body = script
    .replace(/\$\{\{\s*github\.event_name\s*\}\}/g, ctx.event)
    .replace(/\$\{\{\s*inputs\.clawhub_dry_run\s*\}\}/g, String(ctx.dryInput ?? true))
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, "rotifer-protocol/rotifer-playground")
    .replace(/\$\{\{\s*github\.sha\s*\}\}/g, "abc123")
    .replace(/\$\{\{\s*github\.ref\s*\}\}/g, "refs/tags/root-plugin-v" + familyVersion)
    .replace(/\$\{\{\s*steps\.mode\.outputs\.(\w+)\s*\}\}/g, (_, k: string) => outputs[k] ?? "");
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", body], {
    cwd: ROOT,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, GITHUB_OUTPUT: output, GITHUB_WORKSPACE: ROOT },
    encoding: "utf-8",
  });
  const parsed = Object.fromEntries(
    readFileSync(output, "utf-8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]),
  );
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "npx-calls"), "utf-8").split("\n").filter(Boolean);
  } catch {
    /* npx was not called */
  }
  return { status: r.status, stderr: r.stderr, outputs: parsed, calls };
}

describe("release-root-plugin-family.yml publishes the ClawHub package", () => {
  it("runs on the root-plugin tag, on plugin pull requests, and by hand", () => {
    expect(wf.on.push.tags).toContain("root-plugin-v*");
    expect(wf.on.pull_request.paths).toEqual(expect.arrayContaining(["plugin-source/**", "plugins/rotifer/**"]));
    expect(wf.on.workflow_dispatch).toBeTruthy();
    expect(job.needs).toBe("validate");
  });

  it("a tag publishes for real; a pull request and the default dispatch only dry-run", () => {
    const decide = step("Decide what this run does").run!;
    expect(run(decide, { event: "push" }).outputs).toEqual({ version: familyVersion, dry_run: "false" });
    expect(run(decide, { event: "pull_request" }).outputs).toEqual({ version: familyVersion, dry_run: "true" });
    expect(run(decide, { event: "workflow_dispatch" }).outputs.dry_run).toBe("true");
    expect(run(decide, { event: "workflow_dispatch", dryInput: false }).outputs.dry_run).toBe("false");
  });

  it("login and the listing check only run on a real publish", () => {
    for (const name of ["Require a token for a real publish", "Log in", "Confirm the listing moved"]) {
      expect(step(name).if).toBe("steps.mode.outputs.dry_run == 'false'");
    }
  });

  it("publishes plugins/rotifer as the bundle-plugin at the family version, linked to its source", () => {
    const publish = step("Publish the rotifer package").run!;
    const real = run(publish, { event: "push", outputs: { version: familyVersion, dry_run: "false" } });
    expect(real.status, real.stderr).toBe(0);
    const args = real.calls;
    expect(args.slice(0, 4)).toEqual(["--yes", "clawhub@0.23.3", "package", "publish"]);
    expect(args[4]).toBe(join(ROOT, "plugins/rotifer"));
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--family")).toBe("bundle-plugin");
    expect(value("--version")).toBe(familyVersion);
    expect(value("--source-path")).toBe("plugins/rotifer");
    expect(value("--source-commit")).toBe("abc123");
    expect(value("--source-ref")).toBe(`refs/tags/root-plugin-v${familyVersion}`);
    expect(args).not.toContain("--dry-run");

    const dry = run(publish, { event: "pull_request", outputs: { version: familyVersion, dry_run: "true" } });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.calls).toContain("--dry-run");
  });

  it("the version it publishes is the one every plugin manifest carries", () => {
    for (const manifest of ["plugins/rotifer/package.json", "plugins/rotifer/openclaw.plugin.json"]) {
      expect(JSON.parse(readFileSync(join(ROOT, manifest), "utf-8")).version).toBe(familyVersion);
    }
  });
});
