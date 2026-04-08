import { Command } from "commander";
import * as display from "../utils/display.js";
import { openBrowser } from "../utils/open-browser.js";
import {
  loadCredentials,
  saveCredentials,
  startOAuthCallbackServer,
  generateCodeVerifier,
  generateCodeChallenge,
  buildOAuthCallbackUrl,
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
      display.hint("Run 'rotifer logout' to switch accounts");
      return;
    }

    const provider = (options.provider || "github") as AuthProvider;
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      display.error(
        `Unsupported provider: '${provider}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}`
      );
      display.hint("Example: rotifer login --provider github");
      process.exit(1);
    }

    const config = loadCloudConfig();
    const endpoint = options.endpoint || config.endpoint;

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const { port: callbackPort, waitForCallback } = await startOAuthCallbackServer();

    const authUrl =
      `${endpoint}/auth/v1/authorize?provider=${provider}` +
      `&redirect_to=${encodeURIComponent(buildOAuthCallbackUrl(callbackPort))}` +
      `&code_challenge=${codeChallenge}` +
      `&code_challenge_method=S256`;

    display.info(`Opening browser for ${provider} authorization...`);

    const didOpenBrowser = openBrowser(authUrl);
    if (!didOpenBrowser) {
      display.warn("Could not open browser automatically.");
    }

    console.log();
    display.hint("If the browser did not open, copy and paste this URL:");
    console.log(`  ${authUrl}`);
    console.log();

    const s = display.spinner("Waiting for authorization (timeout: 120s)...");

    try {
      const callbackResult = await waitForCallback;

      let accessToken: string;
      let refreshToken: string;

      if (callbackResult.startsWith("implicit:")) {
        const parts = callbackResult.split(":");
        accessToken = parts.slice(1, -1).join(":");
        refreshToken = parts[parts.length - 1];
        s.stop();
      } else {
        s.update("Exchanging authorization code...");
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
          s.stop();
          const err = await tokenRes.text();
          display.error(`Authentication failed: ${err}`);
          display.hint("Check your network connection and try again.");
          process.exit(1);
        }

        const tokenData = (await tokenRes.json()) as any;
        accessToken = tokenData.access_token;
        refreshToken = tokenData.refresh_token;
        s.stop();
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
      display.hint(
        "You can now use 'rotifer publish', 'rotifer search', etc."
      );
    } catch (err: any) {
      s.stop();
      display.error(err.message || "Login failed");
      display.hint("Check your network connection and try again.");
      process.exit(1);
    }
  });
