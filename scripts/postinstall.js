#!/usr/bin/env node
"use strict";

if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (["silent", "warn"].includes(process.env.npm_config_loglevel)) process.exit(0);

let version = "0.0.0";
try {
  version = require("../package.json").version;
} catch {
  // fallback
}

const a = "\x1b[38;2;0;201;167m"; // accent #00C9A7
const d = "\x1b[2m";              // dim
const b = "\x1b[1m";              // bold
const r = "\x1b[0m";              // reset

const logo = [
  "   ____       _   _  __",
  "  |  _ \\ ___ | |_(_)/ _| ___ _ __",
  "  | |_) / _ \\| __| | |_ / _ \\ '__|",
  "  |  _ < (_) | |_| |  _|  __/ |",
  "  |_| \\_\\___/ \\__|_|_|  \\___|_|   v" + version,
];

console.log("");
for (const line of logo) console.log("  " + a + line + r);
console.log("");
console.log("  " + a + b + "Code as Gene" + r + " " + d + "— Open-source evolution framework for AI agents" + r);
console.log("");
console.log("  " + d + "Get started:" + r);
console.log("    " + a + "rotifer init my-agent      " + r + " " + d + "Create an Agent workspace" + r);
console.log("    " + a + "rotifer search             " + r + " " + d + "Browse the gene ecosystem" + r);
console.log("    " + a + "rotifer --help             " + r + " " + d + "See all commands" + r);
console.log("");
console.log("  " + d + "Docs: https://rotifer.dev/docs" + r);
console.log("");
