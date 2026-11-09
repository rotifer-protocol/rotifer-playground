import { execFile } from "node:child_process";
import { win32 } from "node:path";

const CONTROL_OR_SPACE = /[\u0000- \u007f-\u009f]/;

/**
 * Returns the URL in canonical form, or throws when it is not a plain http(s)
 * URL. The checks before `new URL` are needed because the parser is forgiving:
 * it strips tabs and newlines, reads backslashes as slashes, and accepts
 * `https:example.com`. Messages never repeat the input, which may hold a
 * password.
 */
function requireHttpUrl(raw: string): string {
  if (CONTROL_OR_SPACE.test(raw) || raw.includes("\\") || !/^https?:\/\//i.test(raw)) {
    throw new Error("Only a plain http:// or https:// URL can be opened in the browser.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Only a valid http:// or https:// URL can be opened in the browser.");
  }
  if (url.username || url.password) {
    throw new Error("An http(s) URL with a user name or password cannot be opened in the browser.");
  }
  return url.href;
}

/**
 * Get the browser-open binary and arguments for the current platform.
 * Exported separately for testability.
 *
 * On Windows this must not go through cmd.exe: `cmd /c start` parses the URL,
 * so a `&` or `"` in it runs the rest as a command. The path is absolute
 * because Windows looks in the current directory first for a bare name.
 *
 * @throws Error when `url` is not a plain http(s) URL
 */
export function buildOpenCommand(
  url: string,
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): { bin: string; args: string[] } {
  const href = requireHttpUrl(url);
  if (platform === "win32") {
    const bin = win32.join(env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe");
    return { bin, args: ["url.dll,FileProtocolHandler", href] };
  }
  const bin = platform === "darwin" ? "open" : "xdg-open";
  return { bin, args: [href] };
}

/**
 * Open a URL in the user's default browser, cross-platform.
 * Returns true if the command was launched successfully, false on error,
 * including when the URL is not a plain http(s) URL.
 */
export function openBrowser(url: string): boolean {
  try {
    const { bin, args } = buildOpenCommand(url, process.platform);
    const child = execFile(bin, args);
    let didFail = false;
    child.on("error", () => { didFail = true; });
    // Give the spawn a moment; if it errors synchronously we catch above
    return !didFail;
  } catch {
    return false;
  }
}
