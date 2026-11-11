/**
 * The root plugin's copyable `rotifer arena watch` lines parse as the CLI
 * defines the command.
 *
 * The plugin's assistant Skill showed `rotifer arena watch` with no domain and
 * `rotifer arena watch --domain code.security`, but the command takes the
 * domain as a required positional argument (`'all'` for every domain) and has
 * no --domain option. Both lines exit with a usage error when pasted. This
 * reads the argument and option list from the command itself, so the check
 * moves with the CLI instead of restating it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { arenaWatchCommand } from "../../src/commands/arena-watch.js";

const ROOT = process.cwd();
const CONTENT = join(ROOT, "plugin-source/content/root");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

/** Tokens after `rotifer arena watch`, up to a trailing `# comment`. */
function watchInvocations(markdown: string): string[][] {
  return [...markdown.matchAll(/^\s*rotifer arena watch\b([^\n#]*)/gm)].map((m) =>
    m[1].trim().split(/\s+/).filter(Boolean),
  );
}

function problems(tokens: string[]): string[] {
  const found: string[] = [];
  const known = new Set(arenaWatchCommand.options.flatMap((o) => [o.long, o.short].filter(Boolean)));
  const valued = new Set(
    arenaWatchCommand.options.filter((o) => o.required || o.optional).flatMap((o) => [o.long, o.short]),
  );
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      const flag = token.split("=")[0];
      if (!known.has(flag)) found.push(`unknown option ${flag}`);
      if (valued.has(flag) && !token.includes("=")) i++;
    } else {
      positionals.push(token);
    }
  }
  const required = arenaWatchCommand.registeredArguments.filter((a) => a.required).length;
  if (positionals.length < required) found.push(`needs ${required} positional argument(s), got ${positionals.length}`);
  return found;
}

describe("root plugin: arena watch examples run as written", () => {
  const files = markdownFiles(CONTENT);
  const invocations = files.flatMap((file) =>
    watchInvocations(readFileSync(file, "utf-8")).map((tokens) => ({ file: relative(ROOT, file), tokens })),
  );

  it("the plugin still shows arena watch somewhere, so this check is live", () => {
    expect(invocations.length).toBeGreaterThan(0);
  });

  for (const { file, tokens } of invocations) {
    it(`${file}: rotifer arena watch ${tokens.join(" ")}`, () => {
      expect(problems(tokens)).toEqual([]);
    });
  }
});
