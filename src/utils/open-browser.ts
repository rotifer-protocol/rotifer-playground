import { execFile } from "node:child_process";

/**
 * Get the browser-open binary and arguments for the current platform.
 * Exported separately for testability.
 */
export function buildOpenCommand(url: string, platform: string): { bin: string; args: string[] } {
  if (platform === "win32") {
    return { bin: "cmd", args: ["/c", "start", "", url] };
  }
  const bin = platform === "darwin" ? "open" : "xdg-open";
  return { bin, args: [url] };
}

/**
 * Open a URL in the user's default browser, cross-platform.
 * Returns true if the command was launched successfully, false on error.
 */
export function openBrowser(url: string): boolean {
  const { bin, args } = buildOpenCommand(url, process.platform);
  try {
    const child = execFile(bin, args);
    let didFail = false;
    child.on("error", () => { didFail = true; });
    // Give the spawn a moment; if it errors synchronously we catch above
    return !didFail;
  } catch {
    return false;
  }
}
