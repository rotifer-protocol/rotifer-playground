import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { c, icon } from "./palette.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getConfigDir(): string {
  return process.env.ROTIFER_CONFIG_DIR || join(homedir(), ".config", "rotifer");
}

function getCacheFile(): string {
  return join(getConfigDir(), "update-check.json");
}
const REGISTRY_URL = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 5000;

interface UpdateCache {
  [pkg: string]: { lastCheck: number; latest: string };
}

function shouldSkip(): boolean {
  if (process.env.CI) return true;
  if (process.env.NO_UPDATE_NOTIFIER) return true;
  if (process.env.ROTIFER_NO_UPDATE_CHECK) return true;
  if (isRunViaNpx()) return true;
  return false;
}

function isRunViaNpx(): boolean {
  const execPath = process.env.npm_execpath || "";
  const npmCommand = process.env.npm_command || "";
  return execPath.includes("npx") || npmCommand === "exec";
}

function readCache(): UpdateCache {
  try {
    const f = getCacheFile();
    if (existsSync(f)) {
      return JSON.parse(readFileSync(f, "utf-8"));
    }
  } catch { /* corrupt cache, regenerate */ }
  return {};
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(getCacheFile(), JSON.stringify(cache, null, 2));
  } catch { /* non-critical */ }
}

async function fetchLatestVersion(pkgName: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${REGISTRY_URL}/${encodeURIComponent(pkgName)}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function isMajorUpgrade(current: string, latest: string): boolean {
  const curMajor = parseInt(current.split(".")[0], 10);
  const latMajor = parseInt(latest.split(".")[0], 10);
  return latMajor > curMajor;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  isMajor: boolean;
}

/**
 * Non-blocking version check against npm registry.
 * Returns update info if a newer version exists, null otherwise.
 * Caches results for 24 hours. Never throws — fails silently.
 */
export async function checkForUpdate(
  pkgName: string,
  currentVersion: string,
): Promise<UpdateInfo | null> {
  if (shouldSkip()) return null;

  try {
    const cache = readCache();
    const entry = cache[pkgName];

    if (entry && Date.now() - entry.lastCheck < CHECK_INTERVAL_MS) {
      if (compareSemver(entry.latest, currentVersion) > 0) {
        return { current: currentVersion, latest: entry.latest, isMajor: isMajorUpgrade(currentVersion, entry.latest) };
      }
      return null;
    }

    const latest = await fetchLatestVersion(pkgName);
    if (!latest) return null;

    cache[pkgName] = { lastCheck: Date.now(), latest };
    writeCache(cache);

    if (compareSemver(latest, currentVersion) > 0) {
      return { current: currentVersion, latest, isMajor: isMajorUpgrade(currentVersion, latest) };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Synchronous cache-only check. Returns UpdateInfo if cache is fresh and
 * a newer version exists, null otherwise. Never hits the network.
 * Use this to register process.on("exit") handlers that survive process.exit().
 */
export function checkCacheSync(
  pkgName: string,
  currentVersion: string,
): UpdateInfo | null {
  if (shouldSkip()) return null;
  try {
    const cache = readCache();
    const entry = cache[pkgName];
    if (entry && compareSemver(entry.latest, currentVersion) > 0) {
      return { current: currentVersion, latest: entry.latest, isMajor: isMajorUpgrade(currentVersion, entry.latest) };
    }
  } catch { /* non-critical */ }
  return null;
}

export function printUpdateNotification(info: UpdateInfo, pkgName: string): void {
  const border = c.warn(icon.dash.repeat(50));
  console.error("");
  console.error(border);
  console.error(
    c.warn("  Update available: ") +
    c.error(info.current) +
    c.warn(` ${icon.arrow} `) +
    c.success(info.latest),
  );
  if (info.isMajor) {
    console.error(c.error(`  ${icon.warn} Major version upgrade — review breaking changes first`));
  }
  console.error(
    c.warn("  Run ") +
    c.accent(`npm i -g ${pkgName}@latest`) +
    c.warn(" to update"),
  );
  console.error(
    c.warn("  Or: ") +
    c.accent("rotifer self-update"),
  );
  console.error(border);
  console.error("");
}
