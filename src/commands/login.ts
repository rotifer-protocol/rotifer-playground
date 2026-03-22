import { Command } from "commander";
import * as display from "../utils/display.js";
import { openBrowser } from "../utils/open-browser.js";
import {
  loadCredentials,
  saveCredentials,
  waitForOAuthCallback,
  generateCodeVerifier,
  generateCodeChallenge,
} from "../cloud/auth.js";
import { loadCloudConfig } from "../cloud/client.js";
import type { AuthProvider } from "../cloud/types.js";

const SUPPORTED_PROVIDERS: AuthProvider[] = ["github", "gitlab"];

export const loginCommand = new Command("login")
  .description("Log in to Rotifer Cloud")
  .option("--endpoint <url>", "cloud endpoint URL")
  .option(
    "--provider <name>",
    "OAuth provider (github, gitlab)",
    "github"
  )
  .action(async (options: { endpoint?: string; provider?: string }) => {
    display.header("Rotifer Cloud Login");

    const existing = loadCredentials();
    if (existing) {
      display.success(`Already logged in as ${existing.user.username} (via ${existing.provider})`);
      display.info("Run 'rotifer logout' to switch accounts");
      return;
    }

    const provider = (options.provider || "github") as AuthProvider;
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      display.error(
        `Unsupported provider: '${provider}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`
      );
      process.exit(1);
    }

    const config = loadCloudConfig();
    const endpoint = options.endpoint || config.endpoint;

    display.info(`Opening browser for ${provider} authorization...`);

    const callbackPort = 9876;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const authUrl =
      `${endpoint}/auth/v1/authorize?provider=${provider}` +
      `&redirect_to=http://localhost:${callbackPort}/callback` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256`;

    openBrowser(authUrl);

    display.info("Waiting for authorization (timeout: 120s)...");

    try {
      const callbackResult = await waitForOAuthCallback(callbackPort);

      let accessToken: string;
      let refreshToken: string;

      if (callbackResult.startsWith("implicit:")) {
        const parts = callbackResult.split(":");
        accessToken = parts.slice(1, -1).join(":");
        refreshToken = parts[parts.length - 1];
        display.info("Received token via implicit flow");
      } else {
        display.info("Exchanging authorization code for token...");
        const tokenRes = await fetch(
          `${endpoint}/auth/v1/token?grant_type=pkce`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: config.anonKey,
            },
            body: JSON.stringify({
              auth_code: callbackResult,
              code_verifier: codeVerifier,
            }),
          }
        );

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          display.error(`Authentication failed: ${err}`);
          process.exit(1);
        }

        const tokenData = (await tokenRes.json()) as any;
        accessToken = tokenData.access_token;
        refreshToken = tokenData.refresh_token;
      }

      const userRes = await fetch(`${endpoint}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: config.anonKey,
        },
      });

      const userData = (await userRes.json()) as any;
      const meta = userData.user_metadata || {};

      const username =
        meta.user_name ||
        meta.preferred_username ||
        meta.name ||
        meta.nickname ||
        meta.email?.split("@")[0] ||
        "unknown";

      saveCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Date.now() + 3600 * 1000,
        provider,
        user: {
          id: userData.id,
          username,
          avatar_url: meta.avatar_url || null,
          provider_id: meta.provider_id || meta.sub || "",
        },
      });

      console.log();
      display.success(`Logged in as ${username} (via ${provider})`);
      display.keyValue("Endpoint", endpoint);
      display.info(
        "You can now use 'rotifer publish', 'rotifer search', etc."
      );
    } catch (err: any) {
      display.error(err.message || "Login failed");
      process.exit(1);
    }
  });
