import * as vscode from "vscode";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { RotiferCloudClient } from "./cloud-client";

const SECRETS_KEY = "rotifer.credentials";
const LEGACY_CREDS_FILE = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer",
  "credentials.json",
);

/**
 * Fixed loopback port for the OAuth callback. Must exactly match the Supabase Auth
 * "Redirect URLs" allow-list entry (`http://localhost:9876/callback`). Supabase does
 * not match a port wildcard, so with any other port the browser lands on the website
 * and the callback never arrives.
 */
const OAUTH_CALLBACK_PORT = 9876;

interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  provider: string;
  user: {
    id: string;
    username: string;
    avatar_url: string | null;
    provider_id: string;
  };
}

export class AuthManager {
  private statusBarItem: vscode.StatusBarItem;
  private credentials: StoredCredentials | null = null;
  private secrets: vscode.SecretStorage;

  constructor(
    private client: RotiferCloudClient,
    context: vscode.ExtensionContext,
    private oauthCallbackPort: number = OAUTH_CALLBACK_PORT,
  ) {
    this.secrets = context.secrets;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "rotifer.authMenu";
    this.loadCredentials();
    this.updateStatusBar();
    this.statusBarItem.show();
  }

  get disposables(): vscode.Disposable[] {
    return [this.statusBarItem];
  }

  get isLoggedIn(): boolean {
    return this.credentials !== null;
  }

  get username(): string | null {
    return this.credentials?.user.username ?? null;
  }

  private loadCredentials(): void {
    this.secrets.get(SECRETS_KEY).then((raw) => {
      try {
        if (raw) {
          const creds = JSON.parse(raw) as StoredCredentials;
          if (creds.access_token && creds.expires_at > Date.now()) {
            this.credentials = creds;
            this.client.setAccessToken(creds.access_token);
            this.updateStatusBar();
            return;
          }
        }
      } catch { /* ignore malformed data */ }
      this.migrateLegacyCredentials();
    });
  }

  private migrateLegacyCredentials(): void {
    try {
      if (existsSync(LEGACY_CREDS_FILE)) {
        const raw = JSON.parse(readFileSync(LEGACY_CREDS_FILE, "utf-8")) as StoredCredentials;
        if (raw.access_token && raw.expires_at > Date.now()) {
          this.credentials = raw;
          this.client.setAccessToken(raw.access_token);
          this.saveCredentials(raw);
          try { unlinkSync(LEGACY_CREDS_FILE); } catch { /* ignore */ }
          this.updateStatusBar();
          return;
        }
      }
    } catch { /* ignore */ }
    this.credentials = null;
    this.client.setAccessToken(null);
  }

  private saveCredentials(creds: StoredCredentials): void {
    this.credentials = creds;
    this.client.setAccessToken(creds.access_token);
    this.secrets.store(SECRETS_KEY, JSON.stringify(creds));
  }

  private clearCredentials(): void {
    this.credentials = null;
    this.client.setAccessToken(null);
    this.secrets.delete(SECRETS_KEY);
    try { unlinkSync(LEGACY_CREDS_FILE); } catch { /* ignore */ }
  }

  updateStatusBar(): void {
    if (this.credentials) {
      this.statusBarItem.text = `$(account) ${this.credentials.user.username}`;
      this.statusBarItem.tooltip = `Rotifer: logged in as ${this.credentials.user.username} (${this.credentials.provider})`;
    } else {
      this.statusBarItem.text = "$(account) Rotifer: Sign in";
      this.statusBarItem.tooltip = "Click to sign in to Rotifer Cloud";
    }
  }

  async login(): Promise<void> {
    this.loadCredentials();
    if (this.credentials) {
      vscode.window.showInformationMessage(`Already logged in as @${this.credentials.user.username}`);
      return;
    }

    const provider = await vscode.window.showQuickPick(
      [
        { label: "$(mark-github) GitHub", value: "github" },
        { label: "$(git-merge) GitLab", value: "gitlab" },
      ],
      { title: "Sign in to Rotifer Cloud" },
    ) as any;
    if (!provider) return;

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    try {
      const { port: callbackPort, server: cbServer, waitForCallback } = await this.startCallbackServer();
      const authUrl = `${this.client.endpoint}/auth/v1/authorize?provider=${provider.value}&redirect_to=http://localhost:${callbackPort}/callback&code_challenge=${codeChallenge}&code_challenge_method=S256`;

      vscode.env.openExternal(vscode.Uri.parse(authUrl));
      vscode.window.showInformationMessage("Complete sign-in in your browser. Waiting for callback...");

      const code = await waitForCallback;
      const tokenRes = await fetch(`${this.client.endpoint}/auth/v1/token?grant_type=pkce`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: this.client.anonKey },
        body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
      });
      if (!tokenRes.ok) throw new Error("Token exchange failed");
      const tokenData = await tokenRes.json() as any;
      const accessToken: string = tokenData.access_token;
      const refreshToken: string = tokenData.refresh_token;

      this.client.setAccessToken(accessToken);
      const userInfo = await this.client.getUserInfo();

      this.saveCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Date.now() + 3600_000,
        provider: provider.value,
        user: {
          id: userInfo?.id || "",
          username: userInfo?.username || "unknown",
          avatar_url: userInfo?.avatar_url || null,
          provider_id: "",
        },
      });

      this.updateStatusBar();
      vscode.window.showInformationMessage(`Signed in as @${userInfo?.username || "unknown"}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Login failed: ${err.message}`);
    }
  }

  async logout(): Promise<void> {
    if (!this.credentials) {
      vscode.window.showInformationMessage("Not currently signed in.");
      return;
    }
    const username = this.credentials.user.username;
    this.clearCredentials();
    this.updateStatusBar();
    vscode.window.showInformationMessage(`Signed out (was @${username})`);
  }

  private async startCallbackServer(): Promise<{ port: number; server: any; waitForCallback: Promise<string> }> {
    const http = require("node:http") as typeof import("node:http");

    const server = http.createServer();
    // listen() with a host finishes asynchronously: address() is null until then.
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => reject(new Error(
        err.code === "EADDRINUSE"
          ? `Port ${this.oauthCallbackPort} is already in use, so sign-in cannot finish. Close whatever is using it, such as another Rotifer login in progress, and try again.`
          : `Cannot start callback server: ${err.message}`,
      )));
      server.listen(this.oauthCallbackPort, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as any).port as number;

    const waitForCallback = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Login timed out after 120 seconds"));
      }, 120_000);

      server.on("request", (req: any, res: any) => {
        const url = new URL(req.url!, `http://localhost:${port}`);

        if (url.pathname === "/callback") {
          // Only a PKCE code is accepted: it is worthless without this login's
          // code_verifier. A token handed to this port is never accepted, because any
          // page open in the browser can make that request. Supabase does not return a
          // client's state to redirect_to, so there is no state to check here.
          const code = url.searchParams.get("code");

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Login successful! You can close this tab.</h2><script>window.close()</script></body></html>");

          clearTimeout(timeout);
          server.close();

          if (code) {
            resolve(code);
          } else {
            reject(new Error("No auth code in callback"));
          }
        }
      });

      server.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Cannot start callback server: ${err.message}`));
      });
    });

    return { port, server, waitForCallback };
  }
}
