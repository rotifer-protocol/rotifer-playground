import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { loadCredentials } from "../cloud/auth.js";

export const whoamiCommand = new Command("whoami")
  .description("Show current authentication status")
  .action(() => {
    const creds = loadCredentials();

    if (!creds) {
      display.renderResult({ authenticated: false }, () => {
        display.header("Auth Status");
        console.log();
        display.warn("Not logged in");
        display.hint("Log in: rotifer login");
      });
      return;
    }

    const remainingMs = creds.expires_at - Date.now();
    const remainingMin = Math.max(0, Math.round(remainingMs / 60_000));
    const isExpired = remainingMs <= 0;

    display.renderResult(
      {
        authenticated: true,
        username: creds.user.username,
        provider: creds.provider,
        userId: creds.user.id,
        avatarUrl: creds.user.avatar_url,
        expired: isExpired,
        expiresInMin: remainingMin,
      },
      (data) => {
        display.header("Auth Status");
        console.log();
        display.kv("User", c.success(`@${data.username}`));
        display.kv("Provider", data.provider);
        display.kv("User ID", data.userId);

        if (data.avatarUrl) {
          display.kv("Avatar", data.avatarUrl);
        }

        console.log();
        if (data.expired) {
          display.warn("Token expired — will auto-refresh on next API call");
        } else {
          display.kv("Token expires in", `${data.expiresInMin} min`);
        }
      }
    );
  });
