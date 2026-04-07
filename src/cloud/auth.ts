import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { CloudCredentials, CloudConfig } from "./types.js";
import {
  CREDENTIALS_FILE,
  CLOUD_CONFIG_FILE,
  DEFAULT_CLOUD_ENDPOINT,
} from "./types.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);

function ensureRotiferHome(): void {
  if (!existsSync(ROTIFER_HOME)) {
    mkdirSync(ROTIFER_HOME, { recursive: true });
  }
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

export const OAUTH_CALLBACK_HOST = "127.0.0.1";

export function buildOAuthCallbackUrl(port: number, path: string = "/callback"): string {
  return `http://${OAUTH_CALLBACK_HOST}:${port}${path}`;
}

/**
 * Start a local OAuth callback server on a random port (127.0.0.1:0).
 * Returns the bound port immediately so the caller can construct the auth URL,
 * plus a promise that resolves when the callback arrives.
 */
export async function startOAuthCallbackServer(): Promise<{
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

    server.listen(0, OAUTH_CALLBACK_HOST, () => {
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
