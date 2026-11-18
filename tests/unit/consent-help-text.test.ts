import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { runCommand } from "../../src/commands/run.js";
import { agentRunCommand } from "../../src/commands/agent-run.js";
import { testCommand } from "../../src/commands/test.js";
import { arenaSubmitCommand } from "../../src/commands/arena-submit.js";
import { helloCommand } from "../../src/commands/hello.js";
import { publishCommand } from "../../src/commands/publish.js";

/**
 * The credential prompt is asked only before a gene runs in the sandbox:
 * `requireCredentialConsent` is given the genes that will run there, and an
 * external gene run from source under `--trust-unsigned` never passes through
 * it. On Node.js such a gene reads the whole environment, unasked.
 *
 * The two flags' --help said neither. A user who passed --trust-unsigned could
 * read --allow-credentials as a limit that still held. Each command that takes
 * one of the flags is checked on its own --help, as a user reads it.
 */

/** --help as printed, with commander's line wrapping undone. */
const help = (cmd: Command): string => cmd.helpInformation().replace(/\s+/g, " ");

const ASKED_ONLY_IN_SANDBOX = "Asked for only when a gene runs in the sandbox";
const NODE_IS_NOT_ASKED =
  "On Node.js no credential is asked for: the gene can read all your environment variables";

describe("--allow-credentials says it is asked for only in the sandbox", () => {
  it.each([
    ["rotifer run", runCommand],
    ["rotifer agent run", agentRunCommand],
    ["rotifer test", testCommand],
    ["rotifer arena submit", arenaSubmitCommand],
    ["rotifer hello", helloCommand],
  ] as const)("%s --help", (_name, cmd) => {
    expect(help(cmd)).toContain("--allow-credentials <list>");
    expect(help(cmd)).toContain(ASKED_ONLY_IN_SANDBOX);
    // The example has to stay copyable: a half-width @ between name and host.
    expect(help(cmd)).toContain("KEY@api.example.com");
  });
});

describe("--trust-unsigned says Node.js asks for no credential", () => {
  it.each([
    ["rotifer run", runCommand],
    ["rotifer agent run", agentRunCommand],
    ["rotifer hello", helloCommand],
    ["rotifer publish", publishCommand],
  ] as const)("%s --help", (_name, cmd) => {
    expect(help(cmd)).toContain("--trust-unsigned");
    expect(help(cmd)).toContain(NODE_IS_NOT_ASKED);
  });
});
