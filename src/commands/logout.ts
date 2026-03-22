import { Command } from "commander";
import * as display from "../utils/display.js";
import { clearCredentials, loadCredentials } from "../cloud/auth.js";

export const logoutCommand = new Command("logout")
  .description("Log out from Rotifer Cloud")
  .action(async () => {
    display.header("Rotifer Cloud Logout");

    const creds = loadCredentials();
    if (!creds) {
      display.warn("Not currently logged in");
      return;
    }

    const username = creds.user.username;
    clearCredentials();
    display.success(`Logged out from ${username}`);
  });
