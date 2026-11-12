import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import yaml from "js-yaml";
import {
  CLAWHUB_BUNDLE_MANIFESTS,
  PUBLISHED_FORMAT,
  checkClawhubBundle,
  stageClawhubPlugin,
} from "../../scripts/stage-clawhub-plugin.mjs";

/**
 * The root plugin family is also the ClawHub package `rotifer`. Nothing in the
 * release path used to run `clawhub package publish`, so the listing stayed at
 * 0.9.3 (2026-08-18) while the repository moved on.
 *
 * Then the first real publish, root-plugin-v0.9.13, failed on ClawHub's
 * server: "bundle-plugin requires exactly one supported bundle manifest".
 * plugins/rotifer carries both .claude-plugin/ and .cursor-plugin/, and since
 * openclaw/clawhub#4031 a bundle may carry only one. The pull request's
 * --dry-run had passed, because a dry run never reaches the server.
 *
 * The second real publish, from the single-manifest copy, failed on the next
 * server rule: "Native package entrypoints require the code-plugin family",
 * because package.json still declared openclaw.extensions. The copy now drops
 * the native entry point and declares the MCP server where OpenClaw reads a
 * Claude bundle's MCP config.
 *
 * These tests run the publish job's own steps in order, in bash, with a fake
 * `npx` that records its arguments, and then check the folder the job hands
 * to ClawHub the way ClawHub's server does.
 */

const ROOT = join(__dirname, "../..");
const WORKFLOW = join(ROOT, ".github/workflows/release-root-plugin-family.yml");

interface Step { name?: string; id?: string; run?: string; if?: string; uses?: string }
interface Job { needs?: string | string[]; steps: Step[] }
interface Workflow {
  on: { push: { tags: string[] }; pull_request: { paths: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
}

const wf = yaml.load(readFileSync(WORKFLOW, "utf-8")) as Workflow;
const job = wf.jobs["publish-clawhub"];
const step = (name: string) => job.steps.find((s) => s.name === name);
const familyVersion: string = JSON.parse(readFileSync(join(ROOT, "plugin-source/families.json"), "utf-8")).root.version;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "root-plugin-wf-"));
  mkdirSync(join(dir, "runner-temp"));
  const fake = join(dir, "npx");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${dir}/npx-calls"\necho '{}'\n`);
  chmodSync(fake, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Ctx { event: string; dryInput?: boolean }

/** Substitute the GitHub expressions a step uses, then run it in bash from the repo root. */
function runStep(script: string, ctx: Ctx, outputs: Record<string, Record<string, string>>) {
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const body = script
    .replace(/\$\{\{\s*github\.event_name\s*\}\}/g, ctx.event)
    .replace(/\$\{\{\s*inputs\.clawhub_dry_run\s*\}\}/g, String(ctx.dryInput ?? true))
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, "rotifer-protocol/rotifer-playground")
    .replace(/\$\{\{\s*github\.sha\s*\}\}/g, "abc123")
    .replace(/\$\{\{\s*github\.ref\s*\}\}/g, "refs/tags/root-plugin-v" + familyVersion)
    .replace(/\$\{\{\s*steps\.(\w+)\.outputs\.(\w+)\s*\}\}/g, (_, id: string, k: string) => outputs[id]?.[k] ?? "");
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", body], {
    cwd: ROOT,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE: ROOT,
      RUNNER_TEMP: join(dir, "runner-temp"),
    },
    encoding: "utf-8",
  });
  const parsed = Object.fromEntries(
    readFileSync(output, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs: parsed };
}

/** Every `run:` step of the job in order, skipping the ones that only run on a real publish with secrets. */
function runJob(ctx: Ctx) {
  const outputs: Record<string, Record<string, string>> = {};
  const log: string[] = [];
  for (const s of job.steps) {
    if (!s.run) continue;
    if (["Require a token for a real publish", "Log in", "Confirm the listing moved"].includes(s.name ?? "")) continue;
    const r = runStep(s.run, ctx, outputs);
    log.push(`${s.name}: exit ${r.status}${r.stderr ? `\n${r.stderr}` : ""}`);
    if (s.id) outputs[s.id] = r.outputs;
    if (r.status !== 0) return { failedAt: s.name, log, calls: calls() };
  }
  return { failedAt: undefined, log, calls: calls() };
}

function calls(): string[] {
  const path = join(dir, "npx-calls");
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
}

describe("release-root-plugin-family.yml publishes the ClawHub package", () => {
  it("runs on the root-plugin tag, on plugin pull requests, and by hand", () => {
    expect(wf.on.push.tags).toContain("root-plugin-v*");
    expect(wf.on.pull_request.paths).toEqual(
      expect.arrayContaining(["plugin-source/**", "plugins/rotifer/**", "scripts/stage-clawhub-plugin.mjs"]),
    );
    expect(wf.on.workflow_dispatch).toBeTruthy();
    expect(job.needs).toBe("validate");
  });

  it("a tag publishes for real; a pull request and the default dispatch only dry-run", () => {
    const decide = step("Decide what this run does")!.run!;
    expect(runStep(decide, { event: "push" }, {}).outputs).toEqual({ version: familyVersion, dry_run: "false" });
    expect(runStep(decide, { event: "pull_request" }, {}).outputs).toEqual({ version: familyVersion, dry_run: "true" });
    expect(runStep(decide, { event: "workflow_dispatch" }, {}).outputs.dry_run).toBe("true");
    expect(runStep(decide, { event: "workflow_dispatch", dryInput: false }, {}).outputs.dry_run).toBe("false");
  });

  it("login and the listing check only run on a real publish", () => {
    for (const name of ["Require a token for a real publish", "Log in", "Confirm the listing moved"]) {
      expect(step(name)?.if).toBe("steps.mode.outputs.dry_run == 'false'");
    }
  });

  // The root-plugin-v0.9.13 failure, caught before a tag instead of after.
  for (const event of ["push", "pull_request"]) {
    it(`${event}: the folder handed to ClawHub passes its server's bundle-plugin rule`, () => {
      const result = runJob({ event });
      expect(result.failedAt, result.log.join("\n")).toBeUndefined();
      const args = result.calls;
      expect(args.slice(0, 4)).toEqual(["--yes", "clawhub@0.23.3", "package", "publish"]);
      const folder = args[4];
      expect(checkClawhubBundle(folder, familyVersion)).toEqual([]);
      const value = (flag: string) => args[args.indexOf(flag) + 1];
      expect(value("--family")).toBe("bundle-plugin");
      expect(value("--bundle-format")).toBe(PUBLISHED_FORMAT);
      expect(value("--version")).toBe(familyVersion);
      expect(value("--source-path")).toBe("plugins/rotifer");
      expect(value("--source-commit")).toBe("abc123");
      expect(value("--source-ref")).toBe(`refs/tags/root-plugin-v${familyVersion}`);
      if (event === "push") expect(args).not.toContain("--dry-run");
      else expect(args).toContain("--dry-run");
    });
  }

  it("the version it publishes is the one every plugin manifest carries", () => {
    for (const manifest of ["plugins/rotifer/package.json", "plugins/rotifer/openclaw.plugin.json"]) {
      expect(JSON.parse(readFileSync(join(ROOT, manifest), "utf-8")).version).toBe(familyVersion);
    }
  });
});

describe("scripts/stage-clawhub-plugin.mjs", () => {
  const SOURCE_DIR = join(ROOT, "plugins/rotifer");
  const sourceJson = (path: string) => JSON.parse(readFileSync(join(SOURCE_DIR, path), "utf-8"));

  it("plugins/rotifer itself would be rejected, which is why it is staged", () => {
    expect(checkClawhubBundle(SOURCE_DIR, familyVersion)).toEqual([
      "bundle-plugin requires exactly one supported bundle manifest; found 2 (.claude-plugin/plugin.json, .cursor-plugin/plugin.json)",
      "Native package entrypoints require the code-plugin family",
    ]);
  });

  // The copy the second real publish of root-plugin-v0.9.13 sent (run 43147958796):
  // plugins/rotifer without .cursor-plugin/, everything else unchanged.
  it("the copy the second publish sent is rejected for its native entry point and unseen MCP server", () => {
    const old = join(dir, "old-staging");
    cpSync(SOURCE_DIR, old, {
      recursive: true,
      filter: (src) => !relative(SOURCE_DIR, src).split(sep).join("/").startsWith(".cursor-plugin"),
    });
    expect(checkClawhubBundle(old, familyVersion)).toEqual([
      "Native package entrypoints require the code-plugin family",
      'MCP server "rotifer" is not declared where OpenClaw reads a claude bundle (.claude-plugin/plugin.json mcpServers or .mcp.json)',
    ]);
  });

  it("the staged copy keeps one manifest, drops the native entry point, and declares the MCP server", () => {
    const out = join(dir, "staged");
    stageClawhubPlugin(out);
    expect(checkClawhubBundle(out, familyVersion)).toEqual([]);

    const dropped = CLAWHUB_BUNDLE_MANIFESTS.filter((m) => m.format !== PUBLISHED_FORMAT).map((m) => m.path);
    for (const path of [...dropped, "index.js"]) expect(existsSync(join(out, path))).toBe(false);

    const sourcePkg = sourceJson("package.json");
    expect(sourcePkg.openclaw.extensions).toEqual(["./index.js"]);
    const { main: _main, ...pkgWithoutMain } = sourcePkg;
    const { extensions: _extensions, ...openclawWithoutExtensions } = sourcePkg.openclaw;
    const stagedPkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8"));
    expect(stagedPkg).toEqual({ ...pkgWithoutMain, openclaw: openclawWithoutExtensions });

    const servers = sourcePkg.openclaw.mcpServers;
    expect(Object.keys(servers)).toEqual(["rotifer"]);
    const stagedManifest = JSON.parse(readFileSync(join(out, ".claude-plugin/plugin.json"), "utf-8"));
    expect(stagedManifest).toEqual({
      ...sourceJson(".claude-plugin/plugin.json"),
      mcpServers: { rotifer: { command: servers.rotifer.command, args: servers.rotifer.args } },
    });
    expect(stagedManifest.mcpServers.rotifer.args).toContain(
      sourceJson(".cursor-plugin/plugin.json").mcpServers.rotifer.args.find((a: string) => a.startsWith("@rotifer/mcp-server@")),
    );

    for (const kept of [
      ".codebuddy-plugin/plugin.json",
      "openclaw.plugin.json",
      "cordis.patch.yml",
      "README.md",
      "skills/evolve/SKILL.md",
    ]) {
      expect(readFileSync(join(out, kept))).toEqual(readFileSync(join(SOURCE_DIR, kept)));
    }
  });

  it("staging leaves plugins/rotifer untouched", () => {
    const before = ["package.json", ".claude-plugin/plugin.json", "index.js"].map((p) => readFileSync(join(SOURCE_DIR, p)));
    stageClawhubPlugin(join(dir, "staged"));
    const after = ["package.json", ".claude-plugin/plugin.json", "index.js"].map((p) => readFileSync(join(SOURCE_DIR, p)));
    expect(after).toEqual(before);
  });

  it("rejects no bundle manifest, the wrong one, and a version that does not match", () => {
    const out = join(dir, "staged");
    stageClawhubPlugin(out);
    rmSync(join(out, ".claude-plugin"), { recursive: true });
    expect(checkClawhubBundle(out, familyVersion)[0]).toMatch(/exactly one supported bundle manifest; found 0/);

    mkdirSync(join(out, ".cursor-plugin"));
    writeFileSync(join(out, ".cursor-plugin/plugin.json"), JSON.stringify({ name: "rotifer", version: familyVersion }));
    expect(checkClawhubBundle(out, familyVersion)).toEqual([
      "the listing is a claude bundle, but the manifest left is .cursor-plugin/plugin.json",
      'MCP server "rotifer" is not declared where OpenClaw reads a cursor bundle (.cursor-plugin/plugin.json mcpServers or .mcp.json)',
    ]);

    stageClawhubPlugin(out);
    expect(checkClawhubBundle(out, "0.0.0").length).toBeGreaterThan(0);
  });
});
