import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c, icon } from "../utils/palette.js";
import { checkForUpdate } from "../utils/update-check.js";
import { loadUserConfig, saveUserConfig } from "../utils/user-config.js";

export const PACKAGES = ["@rotifer/playground", "@rotifer/mcp-server"];

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

async function runUpdate(shouldRollback: boolean): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
  const currentVersion: string = pkg.version;
  const pm = detectPackageManager();

  if (shouldRollback) {
    const config = loadUserConfig();
    const prev = config["last-version"];
    if (!prev) {
      display.error("No previous version recorded. Cannot rollback.");
      display.hint("Run 'rotifer self-update' at least once before rollback is available.");
      process.exit(1);
    }
    display.info(`Rolling back to ${c.warn(prev)}...`);
    const [cmd, args] = getInstallCommand(pm, "@rotifer/playground", prev);
    execFileSync(cmd, args, { stdio: "inherit" });
    display.success(`Rolled back to ${prev}`);
    return;
  }

  display.header("Self Update");
  display.info("Checking for updates...");

  const results = await Promise.all(
    PACKAGES.map(async (name) => {
      const info = await checkForUpdate(name, currentVersion);
      return { name, info };
    }),
  );

  const updates = results.filter((r) => r.info !== null);

  if (updates.length === 0) {
    display.success("All packages are up to date.");
    return;
  }

  let playgroundUpdatedTo: string | null = null;

  for (const { name, info } of updates) {
    if (!info) continue;
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

    const config = loadUserConfig();
    config["last-version"] = currentVersion;
    saveUserConfig(config);

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
      if (name === "@rotifer/playground") playgroundUpdatedTo = info.latest;
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
