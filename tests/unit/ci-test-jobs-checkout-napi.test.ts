/**
 * The Test jobs run against the napi addon built from the commit under test.
 *
 * They used to take the addon from the `@rotifer/playground-<platform>`
 * package that `npm ci` installs. On main that is the previous release — an
 * addon older than the Rust in the same commit. On a release PR it is nothing:
 * the version bump points optionalDependencies at platform packages that are
 * only published from the tag the release PR creates, the lock regeneration
 * drops their entries (see release-lockfile-window.test.ts), and `npm ci`
 * installs no addon at all. Every test that needs one then fails with "native
 * module not available" — which is how the 0.33.0 release PR went red while
 * main was green.
 *
 * So the jobs build crates/rotifer-napi themselves and hand it to the loader
 * with scripts/use-checkout-napi.mjs, and require the memory functions, so a
 * missing or stale addon fails instead of skipping.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeWithNativeMemory } from "../fixtures/memory/native-memory.js";

const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "use-checkout-napi.mjs");
const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@rotifer/playground-darwin-arm64",
  "darwin-x64": "@rotifer/playground-darwin-x64",
  "linux-x64": "@rotifer/playground-linux-x64-gnu",
  "win32-x64": "@rotifer/playground-win32-x64-msvc",
};
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const LOADED_NAME = `index.${PLATFORM_KEY}.node`;
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** One job of a workflow, as text. */
function jobText(workflow: string, job: string): string {
  const text = readFileSync(join(ROOT, ".github", "workflows", workflow), "utf-8");
  const start = text.indexOf(`\n  ${job}:\n`);
  expect(start, `the ${job} job is gone from ${workflow}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// Every job that runs the test suite. The release workflow's run on the tag
// commit, before its platform packages are published — the same gap as a
// release PR.
const TEST_JOBS: Array<[workflow: string, job: string, testRuns: string[]]> = [
  ["ci.yml", "test", ["run: npm run test:coverage", "run: npm test"]],
  ["release.yml", "validate", ["run: npm test"]],
  ["release.yml", "cross-platform", ["run: npm test"]],
];

describe.each(TEST_JOBS)("%s %s", (workflow, job, testRuns) => {
  it("builds crates/rotifer-napi and hands it to the loader before running the tests", () => {
    const text = jobText(workflow, job);
    const at = (needle: string) => {
      const i = text.indexOf(needle);
      expect(i, `"${needle}" is not in ${workflow} ${job}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const toolchain = at("dtolnay/rust-toolchain@");
    const napiBuild = at("napi build --release --platform");
    const handOver = at("node scripts/use-checkout-napi.mjs");
    expect(toolchain).toBeLessThan(napiBuild);
    expect(napiBuild).toBeLessThan(handOver);
    // The script checks the addon through the built CLI's own loader.
    expect(at("run: npm run build")).toBeLessThan(handOver);
    for (const run of testRuns) expect(handOver).toBeLessThan(at(run));
  });

  it("requires the addon's memory functions, so a missing addon fails rather than skips", () => {
    expect(jobText(workflow, job)).toMatch(/\n {4}env:\n(?: {6}.*\n)* {6}ROTIFER_REQUIRE_NATIVE_MEMORY: "1"\n/);
  });
});

describe("scripts/use-checkout-napi.mjs", () => {
  let root: string;
  const pkg = PLATFORM_PACKAGES[PLATFORM_KEY];
  const run = () => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf-8" });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-checkout-napi-"));
    mkdirSync(join(root, "crates", "rotifer-napi"), { recursive: true });
    // The built CLI's loader, which the script asks for the addon.
    mkdirSync(join(root, "dist", "utils"), { recursive: true });
    for (const file of ["binding.js", "private-fs.js"]) {
      copyFileSync(join(ROOT, "dist", "utils", file), join(root, "dist", "utils", file));
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses when nothing was built", () => {
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no crates/rotifer-napi/index.*.node");
    expect(existsSync(join(root, LOADED_NAME))).toBe(false);
  });

  it("refuses more than one build, rather than guess which is current", () => {
    writeFileSync(join(root, "crates", "rotifer-napi", "index.a.node"), "");
    writeFileSync(join(root, "crates", "rotifer-napi", "index.b.node"), "");
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("more than one");
  });

  it("refuses a file the loader cannot load", () => {
    writeFileSync(join(root, "crates", "rotifer-napi", `index.${PLATFORM_KEY}.node`), "not an addon");
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("the CLI's loader does not load");
  });

  describeWithNativeMemory("with a real addon", () => {
    /** The addon this test run itself loaded, by the loader's own order. */
    const realAddon = () => {
      try {
        return createRequire(join(ROOT, "dist", "utils", "binding.js")).resolve(pkg);
      } catch {
        const local = join(ROOT, LOADED_NAME);
        expect(existsSync(local), `no ${pkg} and no ${LOADED_NAME}`).toBe(true);
        return local;
      }
    };

    it("removes the platform package, puts the build where the loader finds it, and checks it loads", () => {
      const built = join(root, "crates", "rotifer-napi", `index.${PLATFORM_KEY}.node`);
      copyFileSync(realAddon(), built);
      // A stale platform package, as npm ci leaves on main — the loader tries it first.
      const stale = join(root, "node_modules", ...pkg.split("/"));
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, "package.json"), JSON.stringify({ name: pkg, version: "0.0.1", main: "index.js" }));
      writeFileSync(join(stale, "index.js"), "module.exports = {};\n");

      const r = run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(existsSync(stale)).toBe(false);
      // By digest: the addon is tens of MB, and toEqual on two such Buffers exhausts the heap.
      expect(sha256(join(root, LOADED_NAME))).toBe(sha256(built));
      expect(r.stdout).toContain(`loads ${LOADED_NAME}`);
      expect(r.stdout).toContain("memory functions present");
    });
  });
});
