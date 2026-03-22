import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { loadCredentials } from "../cloud/auth.js";

export const whoamiCommand = new Command("whoami")
  .description("Show current authentication status")
  .action(() => {
    display.header("Auth Status");

    const creds = loadCredentials();

    if (!creds) {
      console.log();
      display.warn("Not logged in");
      display.info("Log in: rotifer login");
      return;
    }

    const remainingMs = creds.expires_at - Date.now();
    const remainingMin = Math.max(0, Math.round(remainingMs / 60_000));
    const expired = remainingMs <= 0;

    console.log();
    display.keyValue("User", chalk.green(`@${creds.user.username}`));
    display.keyValue("Provider", creds.provider);
    display.keyValue("User ID", creds.user.id);

    if (creds.user.avatar_url) {
      display.keyValue("Avatar", creds.user.avatar_url);
    }

    console.log();
    if (expired) {
      display.warn("Token expired — will auto-refresh on next API call");
    } else {
      display.keyValue("Token expires in", `${remainingMin} min`);
    }
  });
