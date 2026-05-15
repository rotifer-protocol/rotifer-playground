import { Command } from "commander";
import * as display from "../utils/display.js";
import { getUserConfigValue, setUserConfigValue, isValidKey, loadUserConfig } from "../utils/user-config.js";

export const userConfigCommand = new Command("config")
  .description("Manage global Rotifer configuration")
  .addCommand(
    new Command("get")
      .description("Get a configuration value")
      .argument("<key>", "Configuration key (e.g. update-check)")
      .action((key: string) => {
        if (!isValidKey(key)) {
          display.error(`Unknown config key: ${key}`);
          display.hint("Valid keys: update-check, last-version, default-publish");
          process.exit(1);
        }
        display.kv(key, String(getUserConfigValue(key)));
      }),
  )
  .addCommand(
    new Command("set")
      .description("Set a configuration value")
      .argument("<key>", "Configuration key")
      .argument("<value>", "Value to set")
      .action((key: string, value: string) => {
        if (!isValidKey(key)) {
          display.error(`Unknown config key: ${key}`);
          display.hint("Valid keys: update-check, last-version, default-publish");
          process.exit(1);
        }
        setUserConfigValue(key, value);
        display.success(`${key} = ${value}`);
      }),
  )
  .addCommand(
    new Command("list")
      .description("List all configuration values")
      .action(() => {
        const config = loadUserConfig();

        display.renderResult(config, (data) => {
          const entries = Object.entries(data);
          if (entries.length === 0) {
            display.hint("No configuration set (using defaults).");
            return;
          }
          display.header("Configuration");
          for (const [k, v] of entries) {
            display.kv(k, String(v));
          }
        });
      }),
  );
