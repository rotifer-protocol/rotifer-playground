import * as vscode from "vscode";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RotiferCloudClient } from "./cloud-client";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer",
);
const CREDS_FILE = join(ROTIFER_HOME, "credentials.json");

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

  constructor(private client: RotiferCloudClient) {
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
    try {
      if (existsSync(CREDS_FILE)) {
        const raw = JSON.parse(readFileSync(CREDS_FILE, "utf-8"));
        if (raw.access_token && raw.expires_at > Date.now()) {
          this.credentials = raw;
          this.client.setAccessToken(raw.access_token);
          return;
        }
      }
    } catch { /* ignore */ }
    this.credentials = null;
    this.client.setAccessToken(null);
  }

  private saveCredentials(creds: StoredCredentials): void {
    mkdirSync(ROTIFER_HOME, { recursive: true });
    writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2) + "\n");
    this.credentials = creds;
    this.client.setAccessToken(creds.access_token);
  }

  private clearCredentials(): void {
    try { unlinkSync(CREDS_FILE); } catch { /* ignore */ }
    this.credentials = null;
    this.client.setAccessToken(null);
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

    const callbackPort = 9876;
    const authUrl = `${this.client.endpoint}/auth/v1/authorize?provider=${provider.value}&redirect_to=http://localhost:${callbackPort}/callback`;

    vscode.env.openExternal(vscode.Uri.parse(authUrl));
    vscode.window.showInformationMessage("Complete sign-in in your browser. Waiting for callback...");

    try {
      const result = await this.waitForCallback(callbackPort);
      let accessToken: string;
      let refreshToken: string;

      if (result.startsWith("implicit:")) {
        const parts = result.split(":");
        accessToken = parts.slice(1, -1).join(":");
        refreshToken = parts[parts.length - 1];
      } else {
        const tokenRes = await fetch(`${this.client.endpoint}/auth/v1/token?grant_type=pkce`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: this.client.anonKey },
          body: JSON.stringify({ auth_code: result, code_verifier: "vscode" }),
        });
        if (!tokenRes.ok) throw new Error("Token exchange failed");
        const tokenData = await tokenRes.json() as any;
        accessToken = tokenData.access_token;
        refreshToken = tokenData.refresh_token;
      }

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

  private waitForCallback(port: number): Promise<string> {
    const http = require("node:http") as typeof import("node:http");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Login timed out after 120 seconds"));
      }, 120_000);

      const server = http.createServer((req: any, res: any) => {
        const url = new URL(req.url!, `http://localhost:${port}`);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const accessToken = url.searchParams.get("access_token");
          const refreshToken = url.searchParams.get("refresh_token");

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Login successful! You can close this tab.</h2><script>window.close()</script></body></html>");

          clearTimeout(timeout);
          server.close();

          if (accessToken && refreshToken) {
            resolve(`implicit:${accessToken}:${refreshToken}`);
          } else if (code) {
            resolve(code);
          } else {
            reject(new Error("No auth code or token in callback"));
          }
        }
      });

      server.listen(port, () => {});
      server.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Cannot start callback server: ${err.message}`));
      });
    });
  }
}
