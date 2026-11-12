#!/usr/bin/env node
/**
 * Stage plugins/rotifer for `clawhub package publish` as the bundle-plugin
 * `rotifer`, and check it the way ClawHub's server will.
 *
 *   node scripts/stage-clawhub-plugin.mjs <out-dir>     stage, check, print a JSON summary
 *   node scripts/stage-clawhub-plugin.mjs --check <dir> check an existing folder only
 *
 * Why a staged copy: plugins/rotifer serves several hosts from one folder.
 * ClawHub and OpenClaw read it differently from Cursor and Claude Code, so the
 * copy we hand to ClawHub differs from the source in three ways:
 *
 * 1. Only .claude-plugin/plugin.json is kept. Since openclaw/clawhub#4031
 *    (2026-10-27) a bundle-plugin may carry exactly one of the bundle
 *    manifests ClawHub counts; root-plugin-v0.9.13 was rejected with
 *    "bundle-plugin requires exactly one supported bundle manifest".
 *
 * 2. No native entry point: package.json loses openclaw.extensions and main,
 *    and index.js is dropped. ClawHub refuses a bundle-plugin that declares
 *    openclaw.extensions ("Native package entrypoints require the
 *    code-plugin family"; the second publish of 0.9.13 failed on it), and the
 *    listing cannot become a code-plugin because ClawHub does not allow a
 *    package to change family. OpenClaw also treats a folder with
 *    openclaw.extensions as a native plugin, which then needs a configSchema
 *    in openclaw.plugin.json; without one, OpenClaw 2026.11.3 refuses to
 *    install it ("plugin manifest requires configSchema"). That is why the
 *    live 0.9.3 listing no longer installs.
 *
 * 3. The MCP server moves into .claude-plugin/plugin.json mcpServers.
 *    OpenClaw loads a Claude bundle's MCP servers only from that manifest's
 *    mcpServers or a root .mcp.json; it never reads package.json
 *    openclaw.mcpServers (openclaw/openclaw 74c72a05,
 *    src/plugins/bundle-mcp.ts loadBundleMcpConfig).
 *
 * Everything else, including .codebuddy-plugin/ which ClawHub does not count,
 * is copied unchanged. plugins/rotifer itself is not modified.
 *
 * The CLI's --dry-run never reaches the server and `clawhub package validate`
 * checks the folder as a native plugin, so neither catches these. This check
 * mirrors the server's rules instead.
 *
 * ClawHub's publish-time admission rules for a package, in the order
 * publishPackageImpl (convex/packages.ts) applies them, as read and run
 * locally against this script's output at openclaw/clawhub 23840e27
 * (2026-11-11). Compare against these when ClawHub changes:
 *
 *   1. assertPackageVersion: semver required for code-plugin, not for a bundle.
 *      convex/lib/packageRegistry.ts:433 (called at convex/packages.ts:8253)
 *   2. Per-file and total size limits (10 MiB, 50 MiB).
 *      convex/lib/publishLimits.ts:21, :12 (convex/packages.ts:8420-8425)
 *   3. code-plugin needs source repo and commit. convex/packages.ts:8450
 *   4. selectPluginManifest: a bundle-plugin has exactly one of
 *      .codex-plugin/, .claude-plugin/, .cursor-plugin/ plugin.json, and it
 *      matches --bundle-format. packages/schema/src/pluginInput.ts:7
 *      (convex/packages.ts:8475)                         -> checked here
 *   5. ensurePluginNameMatchesPackage: package.json name is the package name.
 *      convex/lib/packageRegistry.ts:660 (convex/packages.ts:8529) -> checked here
 *   6. code-plugin needs openclaw.plugin.json. convex/packages.ts:8531
 *   7. validateOpenClawExternalCodePluginPackageContents, code-plugin only.
 *      packages/schema/src/openclawContract.ts (convex/packages.ts:8589)
 *   8. extractBundlePluginArtifacts: runtime id from the bundle manifest name;
 *      no non-empty package.json openclaw.extensions (line 642).
 *      convex/lib/packageRegistry.ts:623 (convex/packages.ts:8608) -> checked here
 *   9. extractCodePluginArtifacts, code-plugin only: openclaw.extensions,
 *      openclaw.plugin.json id, configSchema. convex/lib/packageRegistry.ts:579
 *      (convex/packages.ts:8626)
 *  10. classifyPluginCategories: fails only on invalid declared categories in
 *      openclaw.plugin.json. convex/lib/pluginCategoryClassification.ts:108
 *      (convex/packages.ts:8661)
 *  11. An existing package may not change family (the listing is a
 *      bundle-plugin with runtime id rotifer). convex/packages.ts:11613
 *
 * Server-side scans, the Plugin Inspector and publish-token checks also run,
 * but only a real publish exercises them.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = join(REPO_ROOT, "plugins/rotifer");

/**
 * The bundle manifests ClawHub's server counts, in the order its CLI picks
 * one. Mirrors PLUGIN_BUNDLE_MANIFESTS in openclaw/clawhub
 * packages/schema/src/pluginInput.ts.
 */
export const CLAWHUB_BUNDLE_MANIFESTS = [
  { path: ".codex-plugin/plugin.json", format: "codex" },
  { path: ".claude-plugin/plugin.json", format: "claude" },
  { path: ".cursor-plugin/plugin.json", format: "cursor" },
];

/** The one the `rotifer` listing is published with. */
export const PUBLISHED_FORMAT = "claude";

/** The ClawHub package name. */
export const PACKAGE_NAME = "rotifer";

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

/**
 * Problems ClawHub would reject this folder for, as the bundle-plugin rotifer
 * at `version`, plus MCP servers OpenClaw would not see.
 */
export function checkClawhubBundle(dir, version) {
  const problems = [];
  const read = (path) => JSON.parse(readFileSync(join(dir, path), "utf-8"));
  const present = CLAWHUB_BUNDLE_MANIFESTS.filter((m) => existsSync(join(dir, m.path)));

  // Rule 4.
  if (present.length !== 1) {
    problems.push(
      `bundle-plugin requires exactly one supported bundle manifest; found ${present.length}` +
        (present.length ? ` (${present.map((m) => m.path).join(", ")})` : ""),
    );
  }
  for (const required of ["openclaw.plugin.json", "package.json"]) {
    if (!existsSync(join(dir, required))) problems.push(`${required} is missing`);
  }
  const pkg = existsSync(join(dir, "package.json")) ? read("package.json") : undefined;

  if (pkg) {
    // Rule 5.
    if (runtimeIdFromName(pkg.name) !== PACKAGE_NAME) {
      problems.push(`package.json name "${pkg.name}" does not match the package ${PACKAGE_NAME}`);
    }
    // Rule 8 (packageRegistry.ts:642).
    const extensions = pkg.openclaw?.extensions;
    if (Array.isArray(extensions) && extensions.length > 0) {
      problems.push("Native package entrypoints require the code-plugin family");
    }
  }

  if (present.length === 1) {
    const [marker] = present;
    const manifest = read(marker.path);
    // Rule 4: the format we publish with must be the manifest that is left.
    if (marker.format !== PUBLISHED_FORMAT) {
      problems.push(`the listing is a ${PUBLISHED_FORMAT} bundle, but the manifest left is ${marker.path}`);
    }
    // Rule 8: runtime id; rule 11: it must stay rotifer.
    const runtimeId = runtimeIdFromName(manifest.name);
    if (runtimeId !== PACKAGE_NAME) {
      problems.push(`${marker.path} name gives runtime id "${runtimeId}", not "${PACKAGE_NAME}"`);
    }
    // Not a ClawHub rule: OpenClaw only starts MCP servers a bundle declares in
    // its manifest's mcpServers or in .mcp.json.
    const declared = Object.keys(pkg?.openclaw?.mcpServers ?? {});
    const inManifest = Object.keys(manifest.mcpServers ?? {});
    const inDotMcp = existsSync(join(dir, ".mcp.json")) ? Object.keys(read(".mcp.json").mcpServers ?? {}) : [];
    for (const name of declared) {
      if (!inManifest.includes(name) && !inDotMcp.includes(name)) {
        problems.push(
          `MCP server "${name}" is not declared where OpenClaw reads a ${marker.format} bundle ` +
            `(${marker.path} mcpServers or .mcp.json)`,
        );
      }
    }
  }

  if (version !== undefined) {
    for (const path of ["package.json", "openclaw.plugin.json", ...present.map((m) => m.path)]) {
      if (!existsSync(join(dir, path))) continue;
      const declaredVersion = read(path).version;
      if (declaredVersion !== version) problems.push(`${path} declares version ${declaredVersion}, not ${version}`);
    }
  }
  return problems;
}

/**
 * Copy `source` to `out` the way the listing ships: one bundle manifest, no
 * native entry point, and the MCP server declared in that manifest.
 */
export function stageClawhubPlugin(out, source = SOURCE) {
  const published = CLAWHUB_BUNDLE_MANIFESTS.find((m) => m.format === PUBLISHED_FORMAT);
  const drop = CLAWHUB_BUNDLE_MANIFESTS.filter((m) => m !== published).map((m) => dirname(m.path));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(source, out, {
    recursive: true,
    filter: (src) => {
      const rel = relative(source, src).split(sep).join("/");
      return !drop.some((d) => rel === d || rel.startsWith(`${d}/`));
    },
  });

  const pkgPath = join(out, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const servers = pkg.openclaw?.mcpServers ?? {};
  if (pkg.openclaw) delete pkg.openclaw.extensions;
  delete pkg.main;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  rmSync(join(out, "index.js"), { force: true });

  const manifestPath = join(out, published.path);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, { command: server.command, args: server.args }]),
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

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
