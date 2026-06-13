import { Command } from "commander";
import * as display from "../utils/display.js";
import {
  preflightToolchain,
  resolveActiveNpxPath,
  formatToolchainReport,
  toolchainOk,
} from "../utils/javy-compiler.js";

export const doctorCommand = new Command("doctor")
  .description("Check the TypeScript→WASM toolchain (esbuild / javy) and report what's wrong")
  .action(() => {
    display.header("Rotifer Doctor — TS→WASM toolchain");

    const status = preflightToolchain();
    for (const line of formatToolchainReport(status, resolveActiveNpxPath())) {
      console.log(line);
    }
    console.log();

    if (toolchainOk(status)) {
      display.success("Toolchain ready — `rotifer compile` can build Native WASM Genes.");
      return;
    }

    display.error("Toolchain incomplete — `rotifer compile` will fail at the TS→WASM step.");
    display.hint("Install: npm i -g esbuild javy-cli   (javy-cli installs a binary named `javy`)");
    display.hint("Then ensure the Node prefix that owns `rotifer` is first in PATH.");
    process.exit(1);
  });
