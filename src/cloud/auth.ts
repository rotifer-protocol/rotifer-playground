import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { CloudCredentials, CloudConfig } from "./types.js";
import {
  CREDENTIALS_FILE,
  CLOUD_CONFIG_FILE,
  DEFAULT_CLOUD_ENDPOINT,
} from "./types.js";
import { ensurePrivateDir, tightenPrivateFile } from "../utils/private-fs.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);

function ensureRotiferHome(): void {
  ensurePrivateDir(ROTIFER_HOME);
}

function credentialsPath(): string {
  return join(ROTIFER_HOME, CREDENTIALS_FILE);
}

function loadCloudConfigForAuth(): CloudConfig {
  const configPath = join(ROTIFER_HOME, CLOUD_CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as CloudConfig;
    } catch {
      /* fall through */
    }
  }
  return {
    endpoint: DEFAULT_CLOUD_ENDPOINT,
    anonKey: process.env.ROTIFER_CLOUD_ANON_KEY || "",
  };
}

export function loadCredentials(): CloudCredentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as CloudCredentials;
    if (data.expires_at && Date.now() > data.expires_at) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Attempt to refresh an expired token using the stored refresh_token.
 * On success, saves new credentials to disk so subsequent sync reads
 * pick up the fresh token automatically.
 */
export async function refreshTokenIfNeeded(): Promise<void> {
  const path = credentialsPath();
  if (!existsSync(path)) return;

  let data: CloudCredentials;
  try {
    data = JSON.parse(readFileSync(path, "utf-8")) as CloudCredentials;
  } catch {
    return;
  }

  if (!data.expires_at || Date.now() <= data.expires_at) return;
  if (!data.refresh_token) return;

  const config = loadCloudConfigForAuth();
  const endpoint = config.endpoint.replace(/\/+$/, "");

  try {
    const res = await fetch(
      `${endpoint}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.anonKey,
        },
        body: JSON.stringify({ refresh_token: data.refresh_token }),
      }
    );

    if (!res.ok) return;

    const result = (await res.json()) as Record<string, any>;
    const newCreds: CloudCredentials = {
      access_token: result.access_token,
      refresh_token: result.refresh_token || data.refresh_token,
      expires_at: Date.now() + ((result.expires_in as number) || 3600) * 1000,
      provider: data.provider,
      user: data.user,
    };
    saveCredentials(newCreds);
  } catch {
    // Refresh failed silently — loadCredentials will return null
  }
}

export function saveCredentials(creds: CloudCredentials): void {
  ensureRotiferHome();
  writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
  tightenPrivateFile(credentialsPath());
}

export function clearCredentials(): void {
  const path = credentialsPath();
  if (existsSync(path)) {
    writeFileSync(path, "", { mode: 0o600 });
    require("node:fs").unlinkSync(path);
  }
}

export function isLoggedIn(): boolean {
  return loadCredentials() !== null;
}

export async function requireAuth(): Promise<CloudCredentials> {
  await refreshTokenIfNeeded();
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "Not logged in. Run 'rotifer login' first."
    );
  }
  return creds;
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Loopback interface the callback server binds to (IPv4, avoids localhost→::1). */
export const OAUTH_CALLBACK_HOST = "127.0.0.1";

/**
 * Fixed loopback port for the OAuth callback. Must exactly match a Supabase Auth
 * "Redirect URLs" allow-list entry (`http://localhost:9876/callback`); Supabase
 * does not match a port wildcard, so a random port falls back to the Site URL
 * (the website) and the local listener never receives the token.
 */
export const OAUTH_CALLBACK_PORT = 9876;

export function buildOAuthCallbackUrl(port: number, path: string = "/callback"): string {
  // Host is `localhost` to match the Supabase redirect allow-list; the server
  // binds the IPv4 loopback (OAUTH_CALLBACK_HOST), which localhost resolves to.
  return `http://localhost:${port}${path}`;
}

/**
 * Start the local OAuth callback server. Defaults to the fixed, allow-listed
 * port 9876 so the OAuth `redirect_to` matches Supabase's allow-list; pass `0`
 * (e.g. in tests) for a random ephemeral port to avoid cross-test port
 * contention. Returns the bound port plus a promise that resolves when the
 * callback arrives.
 */
export async function startOAuthCallbackServer(
  port: number = OAUTH_CALLBACK_PORT,
): Promise<{
  port: number;
  waitForCallback: Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    let callbackResolve: (value: string) => void;
    let callbackReject: (reason: Error) => void;
    const waitForCallback = new Promise<string>((res, rej) => {
      callbackResolve = res;
      callbackReject = rej;
    });

    const server = createServer((req, res) => {
      const boundPort = (server.address() as { port: number })?.port || 0;
      const url = new URL(req.url || "/", buildOAuthCallbackUrl(boundPort));

      if (url.pathname === "/callback/token") {
        const token = url.searchParams.get("access_token");
        const refresh = url.searchParams.get("refresh_token");
        if (token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h2>Login successful!</h2>" +
              "<p>You can close this window and return to the terminal.</p>" +
              "</body></html>"
          );
          server.close();
          callbackResolve(`implicit:${token}:${refresh || ""}`);
          return;
        }
      }

      const code = url.searchParams.get("code");
      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Login successful!</h2>" +
            "<p>You can close this window and return to the terminal.</p>" +
            "</body></html>"
        );
        server.close();
        callbackResolve(code);
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><script>
if (window.location.hash) {
  var params = new URLSearchParams(window.location.hash.substring(1));
  var token = params.get('access_token');
  var refresh = params.get('refresh_token');
  if (token) {
    window.location.href = '/callback/token?access_token=' + encodeURIComponent(token) + '&refresh_token=' + encodeURIComponent(refresh || '');
  } else {
    document.body.innerHTML = '<h2>Login failed</h2><p>No token received.</p>';
  }
} else {
  document.body.innerHTML = '<h2>Login failed</h2><p>Missing authorization data.</p>';
}
</script><noscript>Enable JavaScript to complete login.</noscript></body></html>`);
      }
    });

    server.listen(port, OAUTH_CALLBACK_HOST, () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, waitForCallback });
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    setTimeout(() => {
      server.close();
      callbackReject(new Error("Login timed out after 120 seconds"));
    }, 120_000);
  });
}
