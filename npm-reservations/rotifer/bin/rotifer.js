#!/usr/bin/env node

// This package exists so the unscoped `rotifer` name cannot be used to
// impersonate the Rotifer Protocol toolchain. The real CLI ships as
// @rotifer/playground; anything that reaches this binary was pointed at the
// wrong package name, so say so plainly and exit non-zero rather than
// pretending to be the CLI.

const args = process.argv.slice(2).join(" ");
const suggestion = args ? `npx -y @rotifer/playground ${args}` : "npm install -g @rotifer/playground";

process.stderr.write(
  [
    "",
    "  This is not the Rotifer CLI.",
    "",
    "  The `rotifer` name on npm is a pointer reserved by the Rotifer Protocol",
    "  project. The CLI is published as @rotifer/playground.",
    "",
    "    " + suggestion,
    "",
    "  Docs: https://rotifer.dev",
    "",
  ].join("\n"),
);

process.exit(1);
