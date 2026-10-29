import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface RotiferConfig {
  name: string;
  version: string;
  author: string;
  genes_dir: string;
  default_domain?: string;
}

const CONFIG_FILE = "rotifer.json";

export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (dir !== "/") {
    if (existsSync(join(dir, CONFIG_FILE))) {
      return dir;
    }
    dir = join(dir, "..");
  }
  return null;
}

/**
 * rotifer.json exists but cannot be read as a config. The CLI entry point
 * reports it as a message, not a stack (#456); the file is never rewritten.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(projectDir?: string): RotiferConfig {
  const root = projectDir || findProjectRoot();
  if (!root) {
    throw new Error(
      `No ${CONFIG_FILE} found. Run 'rotifer init' first.`
    );
  }

  const configPath = join(root, CONFIG_FILE);
  const content = readFileSync(configPath, "utf-8");
  try {
    return JSON.parse(content) as RotiferConfig;
  } catch (err) {
    throw new ConfigError(`${configPath} is not valid JSON: ${(err as Error).message}`);
  }
}

export function saveConfig(config: RotiferConfig, projectDir: string): void {
  const configPath = join(projectDir, CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function getProjectRoot(): string {
  const root = findProjectRoot();
  if (!root) {
    throw new Error(
      `No ${CONFIG_FILE} found. Run 'rotifer init' to create a new Agent workspace.`
    );
  }
  return root;
}
