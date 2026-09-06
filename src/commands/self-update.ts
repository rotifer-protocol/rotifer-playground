import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c, icon } from "../utils/palette.js";
import { checkForUpdate } from "../utils/update-check.js";
import { loadUserConfig, saveUserConfig } from "../utils/user-config.js";

export const PACKAGES = ["@rotifer/playground", "@rotifer/mcp-server"];

/** The package this CLI itself ships in — the only one whose version we can
 *  read straight off disk. */
export const OWN_PACKAGE = "@rotifer/playground";

/**
 * The globally-installed executable each package provides. A global install is
 * exactly the act of putting these on PATH, so asking the binary for its own
 * version is both package-manager agnostic and a truthful answer to the
 * question that actually matters: "which copy would run right now?"
 */
export const BIN_FOR_PACKAGE: Record<string, string> = {
  "@rotifer/playground": "rotifer",
  "@rotifer/mcp-server": "rotifer-mcp-server",
};

export function detectPackageManager(): string {
  const userAgent = process.env.npm_config_user_agent || "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
}

export function getInstallCommand(pm: string, pkg: string, version: string): [string, string[]] {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case "pnpm": return ["pnpm", ["add", "-g", spec]];
    case "yarn": return ["yarn", ["global", "add", spec]];
    case "bun": return ["bun", ["add", "-g", spec]];
    default: return ["npm", ["install", "-g", spec]];
  }
}

/** First semver-looking token in a `--version` output. Both binaries print the
 *  bare version, but the CLI can append an update banner underneath it. */
export function parseVersionOutput(out: string): string | null {
  const m = out.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return m ? m[1] : null;
}

/**
 * The installed version of `pkg`, or null when it is not installed.
 *
 * This exists because of a bug that made the whole @rotifer/mcp-server half of
 * this command dead code: every package was checked against *this* CLI's
 * version. Since the two packages version independently, mcp-server's real
 * release (0.18.0) was compared against playground's (0.24.0), judged older,
 * and silently skipped — both the 0.17.0 and 0.18.0 releases went unoffered.
 * Whenever the numbers happened to fall the other way the update did fire, but
 * announced the wrong "current" version, so even the working case was working
 * by coincidence rather than by logic.
 *
 * Returning null for an absent package is deliberate: a package the user never
 * installed must not be installed by an *update* command.
 */
export function getInstalledVersion(pkg: string, ownVersion: string): string | null {
  if (pkg === OWN_PACKAGE) return ownVersion;

  const bin = BIN_FOR_PACKAGE[pkg];
  if (!bin) return null;

  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      // Don't let the probe trigger the probed binary's own registry lookup.
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", ROTIFER_NO_UPDATE_CHECK: "1" },
    });
    return parseVersionOutput(out);
  } catch {
    // Not on PATH, not installed, or refused to run — all mean the same thing
    // here: there is no installed copy for this command to upgrade.
    return null;
  }
}

export async function verifyProvenance(pkg: string, version: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${version}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return false;
    const data = await res.json() as { dist?: { attestations?: unknown } };
    return !!data.dist?.attestations;
  } catch {
    return false;
  }
}

/** Previous versions recorded by the last successful update, newest schema
 *  first. `last-version` is the pre-multi-package field and is still written
 *  so an older CLI (and `rotifer config get last-version`) keeps working. */
export function readRollbackTargets(config: ReturnType<typeof loadUserConfig>): Record<string, string> {
  const map = config["last-versions"];
  if (map && Object.keys(map).length > 0) return map;
  const legacy = config["last-version"];
  return legacy ? { [OWN_PACKAGE]: legacy } : {};
}

export interface UpdateTarget {
  name: string;
  /** null when the package is not installed on this machine. */
  installed: string | null;
  info: Awaited<ReturnType<typeof checkForUpdate>>;
}

/**
 * What, if anything, each package needs. Extracted so the pairing that used to
 * be wrong — which version each package is compared against — is directly
 * assertable in a test rather than buried in the command's side effects.
 */
export async function resolveUpdateTargets(ownVersion: string): Promise<UpdateTarget[]> {
  return Promise.all(
    PACKAGES.map(async (name): Promise<UpdateTarget> => {
      // Each package is compared against its OWN installed version. Passing
      // this CLI's version here is what broke mcp-server updates entirely.
      const installed = getInstalledVersion(name, ownVersion);
      if (!installed) return { name, installed: null, info: null };
      return { name, installed, info: await checkForUpdate(name, installed) };
    }),
  );
}

async function runUpdate(shouldRollback: boolean): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
  const currentVersion: string = pkg.version;
  const pm = detectPackageManager();

  if (shouldRollback) {
    const targets = readRollbackTargets(loadUserConfig());
    const names = Object.keys(targets);
    if (names.length === 0) {
      display.error("No previous version recorded. Cannot rollback.");
      display.hint("Run 'rotifer self-update' at least once before rollback is available.");
      process.exit(1);
    }
    for (const name of names) {
      const prev = targets[name];
      display.info(`Rolling back ${c.accent(name)} to ${c.warn(prev)}...`);
      const [cmd, args] = getInstallCommand(pm, name, prev);
      execFileSync(cmd, args, { stdio: "inherit" });
      display.success(`${name} rolled back to ${prev}`);
    }
    return;
  }

  display.header("Self Update");
  display.info("Checking for updates...");

  const results = await resolveUpdateTargets(currentVersion);

  for (const { name, installed } of results) {
    if (!installed) {
      display.info(`${c.accent(name)} is not installed — skipping.`);
    }
  }

  const updates = results.filter((r) => r.info !== null);

  if (updates.length === 0) {
    display.success("All installed packages are up to date.");
    return;
  }

  let playgroundUpdatedTo: string | null = null;
  const rolledBackFrom: Record<string, string> = {};

  for (const { name, installed, info } of updates) {
    if (!info || !installed) continue;
    console.log(`  ${c.accent(name)}: ${c.error(info.current)} ${icon.arrow} ${c.success(info.latest)}`);

    if (info.isMajor) {
      display.warn("Major version upgrade");
      const url = `https://rotifer.dev/docs/migration/v${info.latest.split(".")[0]}`;
      display.hint(`Review: ${display.link(url, url)}`);

      if (!process.stdout.isTTY) {
        display.error("Major upgrade requires interactive confirmation. Use --yes to skip.");
        continue;
      }

      const clack = await import("@clack/prompts");
      const proceed = await clack.confirm({ message: "Proceed with major upgrade?" });
      if (clack.isCancel(proceed) || !proceed) {
        display.info(`Skipping ${name}`);
        continue;
      }
    }

    display.info(`Verifying provenance for ${c.accent(name + "@" + info.latest)}...`);
    const hasProvenance = await verifyProvenance(name, info.latest);
    if (!hasProvenance) {
      display.error(`No provenance attestation found for ${name}@${info.latest}`);
      display.hint(`For safety, install manually: ${pm} install -g ${name}@${info.latest}`);
      continue;
    }
    display.success("Provenance verified");

    const [cmd, args] = getInstallCommand(pm, name, info.latest);

    try {
      const doesNeedSudo = process.platform !== "win32" && checkNeedsSudo(pm);
      if (doesNeedSudo) {
        display.error("Global install requires elevated permissions.");
        display.hint(`Run manually: sudo ${cmd} ${args.join(" ")}`);
        continue;
      }

      display.info(`Installing ${c.accent(name + "@" + info.latest)}...`);
      execFileSync(cmd, args, { stdio: "inherit" });
      display.success(`${name} updated to ${info.latest}`);

      // Recorded only after the install actually succeeded, and per package —
      // rollback used to reinstall @rotifer/playground no matter which package
      // had been upgraded.
      rolledBackFrom[name] = installed;
      const config = loadUserConfig();
      config["last-versions"] = { ...config["last-versions"], ...rolledBackFrom };
      if (name === OWN_PACKAGE) config["last-version"] = installed;
      saveUserConfig(config);

      if (name === OWN_PACKAGE) playgroundUpdatedTo = info.latest;
      if (name === "@rotifer/mcp-server") {
        display.hint("Restart your MCP host (Claude Code, Cursor, …) for the new server to load.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      display.error(`Update failed: ${msg}`);
      display.hint(`Try manually: ${cmd} ${args.join(" ")}`);
    }
  }

  if (playgroundUpdatedTo) {
    display.welcomeBanner({
      version: playgroundUpdatedTo,
      message: `Updated to v${playgroundUpdatedTo}!`,
      docsUrl: `https://rotifer.dev/blog/v${playgroundUpdatedTo}`,
    });
  }
}

function checkNeedsSudo(pm: string): boolean {
  if (pm !== "npm") return false;
  try {
    const prefix = execFileSync("npm", ["config", "get", "prefix"], { encoding: "utf-8" }).trim();
    const fs = require("node:fs");
    fs.accessSync(prefix, fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export const selfUpdateCommand = new Command("self-update")
  .description("Check for updates and upgrade Rotifer packages")
  .option("--rollback", "Roll back to the previously installed version")
  .action(async (opts: { rollback?: boolean }) => {
    await runUpdate(!!opts.rollback);
  });
