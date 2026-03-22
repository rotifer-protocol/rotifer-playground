import { exec } from "node:child_process";

/**
 * Build the shell command to open a URL in the default browser.
 * Exported separately for testability.
 */
export function buildOpenCommand(url: string, platform: string): string {
  if (platform === "win32") {
    return `start "" "${url}"`;
  }
  const bin = platform === "darwin" ? "open" : "xdg-open";
  return `${bin} "${url}"`;
}

/**
 * Open a URL in the user's default browser, cross-platform.
 */
export function openBrowser(url: string): void {
  exec(buildOpenCommand(url, process.platform));
}
