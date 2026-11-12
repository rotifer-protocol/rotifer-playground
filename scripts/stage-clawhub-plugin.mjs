#!/usr/bin/env node
/**
 * Stage plugins/rotifer for `clawhub package publish` as the bundle-plugin
 * `rotifer`, and check it the way ClawHub's server will.
 *
 *   node scripts/stage-clawhub-plugin.mjs <out-dir>     stage, check, print a JSON summary
 *   node scripts/stage-clawhub-plugin.mjs --check <dir> check an existing folder only
 *
 * Why a staged copy: plugins/rotifer serves several hosts from one folder, so
 * it carries both .claude-plugin/plugin.json (Claude Code) and
 * .cursor-plugin/plugin.json (Cursor). Since openclaw/clawhub#4031
 * (2026-10-27) the server rejects a bundle-plugin with more than one of the
 * bundle manifests it supports: "bundle-plugin requires exactly one supported
 * bundle manifest". root-plugin-v0.9.13 failed on exactly that. The CLI's
 * --dry-run never reaches the server and `clawhub package validate` checks
 * the folder as a native plugin, so neither catches it; this check does.
 *
 * The listing was created as a bundle-plugin in the `claude` format (the CLI
 * picks the first of codex/claude/cursor it finds, and 0.9.0-0.9.3 were
 * published with all three present), so the staged copy keeps
 * .claude-plugin/plugin.json and drops the other supported bundle manifests.
 * Everything else, including .codebuddy-plugin/ which ClawHub does not count,
 * is copied unchanged.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = join(REPO_ROOT, "plugins/rotifer");

/**
 * The bundle manifests ClawHub's server counts, in the order its CLI picks
 * one. Mirrors PLUGIN_BUNDLE_MANIFESTS in openclaw/clawhub
 * packages/schema/src/pluginInput.ts (bff45138, 2026-10-27).
 */
export const CLAWHUB_BUNDLE_MANIFESTS = [
  { path: ".codex-plugin/plugin.json", format: "codex" },
  { path: ".claude-plugin/plugin.json", format: "claude" },
  { path: ".cursor-plugin/plugin.json", format: "cursor" },
];

/** The one the `rotifer` listing is published with. */
export const PUBLISHED_FORMAT = "claude";

/** ClawHub's bundlePluginRuntimeId: the listing's runtime id comes from the manifest name. */
export function runtimeIdFromName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [relative(dir, path).split(sep).join("/")];
  });
}

/** Problems ClawHub would reject this folder for, as a bundle-plugin named rotifer at `version`. */
export function checkClawhubBundle(dir, version) {
  const problems = [];
  const present = CLAWHUB_BUNDLE_MANIFESTS.filter((m) => existsSync(join(dir, m.path)));
  if (present.length !== 1) {
    problems.push(
      `bundle-plugin requires exactly one supported bundle manifest; found ${present.length}` +
        (present.length ? ` (${present.map((m) => m.path).join(", ")})` : ""),
    );
  }
  const read = (path) => JSON.parse(readFileSync(join(dir, path), "utf-8"));
  for (const required of ["openclaw.plugin.json", "package.json"]) {
    if (!existsSync(join(dir, required))) problems.push(`${required} is missing`);
  }
  if (present.length === 1) {
    const [marker] = present;
    if (marker.format !== PUBLISHED_FORMAT) {
      problems.push(`the listing is a ${PUBLISHED_FORMAT} bundle, but the manifest left is ${marker.path}`);
    }
    const runtimeId = runtimeIdFromName(read(marker.path).name);
    if (runtimeId !== "rotifer") problems.push(`${marker.path} name gives runtime id "${runtimeId}", not "rotifer"`);
  }
  if (version !== undefined) {
    for (const path of ["package.json", "openclaw.plugin.json", ...present.map((m) => m.path)]) {
      if (!existsSync(join(dir, path))) continue;
      const declared = read(path).version;
      if (declared !== version) problems.push(`${path} declares version ${declared}, not ${version}`);
    }
  }
  return problems;
}

/** Copy `source` to `out` without the bundle manifests the listing does not use. */
export function stageClawhubPlugin(out, source = SOURCE) {
  const drop = CLAWHUB_BUNDLE_MANIFESTS.filter((m) => m.format !== PUBLISHED_FORMAT).map((m) => dirname(m.path));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(source, out, {
    recursive: true,
    filter: (src) => {
      const rel = relative(source, src).split(sep).join("/");
      return !drop.some((d) => rel === d || rel.startsWith(`${d}/`));
    },
  });
  return { dir: out, format: PUBLISHED_FORMAT, files: filesUnder(out).length };
}

function familyVersion() {
  return JSON.parse(readFileSync(join(REPO_ROOT, "plugin-source/families.json"), "utf-8")).root.version;
}

function fail(problems) {
  for (const p of problems) console.error(`::error::ClawHub would reject this package: ${p}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = familyVersion();
  if (args[0] === "--check" && args[1]) {
    const problems = checkClawhubBundle(resolve(args[1]), version);
    if (problems.length) fail(problems);
    console.log(`${args[1]} passes ClawHub's bundle-plugin admission rules for rotifer ${version}.`);
  } else if (args.length === 1 && !args[0].startsWith("-")) {
    const summary = stageClawhubPlugin(resolve(args[0]));
    const problems = checkClawhubBundle(summary.dir, version);
    if (problems.length) fail(problems);
    console.log(JSON.stringify({ ...summary, version }));
  } else {
    console.error("usage: stage-clawhub-plugin.mjs <out-dir> | --check <dir>");
    process.exit(2);
  }
}
