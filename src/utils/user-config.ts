import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function getConfigDir(): string {
  return process.env.ROTIFER_CONFIG_DIR || join(homedir(), ".config", "rotifer");
}

function getUserConfigFile(): string {
  return join(getConfigDir(), "config.json");
}

export interface UserConfig {
  "update-check"?: boolean;
  /** Pre-multi-package rollback target; still written for @rotifer/playground
   *  so an older CLI and `rotifer config get last-version` keep working. */
  "last-version"?: string;
  /** Per-package rollback targets, written by `rotifer self-update`. */
  "last-versions"?: Record<string, string>;
  "default-publish"?: boolean;
}

const DEFAULTS: Required<UserConfig> = {
  "update-check": true,
  "last-version": "",
  // Not exposed through `rotifer config` (see VALID_KEYS) — self-update owns it.
  "last-versions": {},
  "default-publish": true,
};

const VALID_KEYS = new Set<keyof UserConfig>(["update-check", "last-version", "default-publish"]);

export function isValidKey(key: string): key is keyof UserConfig {
  return VALID_KEYS.has(key as keyof UserConfig);
}

export function loadUserConfig(): UserConfig {
  try {
    const f = getUserConfigFile();
    if (existsSync(f)) {
      return JSON.parse(readFileSync(f, "utf-8"));
    }
  } catch { /* corrupt config, use defaults */ }
  return {};
}

export function saveUserConfig(config: UserConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getUserConfigFile(), JSON.stringify(config, null, 2) + "\n");
}

export function getUserConfigValue(key: keyof UserConfig): string {
  const config = loadUserConfig();
  const val = config[key] ?? DEFAULTS[key];
  return String(val);
}

export function setUserConfigValue(key: keyof UserConfig, value: string): void {
  const config = loadUserConfig();
  if (key === "update-check" || key === "default-publish") {
    config[key] = value === "true" || value === "1";
  } else {
    (config as Record<string, unknown>)[key] = value;
  }
  saveUserConfig(config);
}

export function shouldAutoPublish(): boolean {
  const envOverride = process.env.ROTIFER_AUTO_PUBLISH;
  if (envOverride !== undefined) {
    return envOverride !== "false" && envOverride !== "0";
  }
  const config = loadUserConfig();
  return config["default-publish"] ?? DEFAULTS["default-publish"];
}
