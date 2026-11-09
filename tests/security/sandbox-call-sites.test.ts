import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A sandbox call that goes around utils/credential-consent runs an external
 * gene with no limit on the credentials it can use (#508).
 */

const SRC = join(__dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const callers = sourceFiles(SRC).filter((f) => /\.execute(Gene|Algebra)\(/.test(readFileSync(f, "utf-8")));

describe("sandbox call sites", () => {
  it("only utils/credential-consent calls the sandbox directly", () => {
    expect(callers.map((f) => relative(SRC, f))).toEqual(["utils/credential-consent.ts"]);
  });

  it.each(["run", "agent-run", "test", "arena-submit", "hello"])("%s takes --allow-credentials", (command) => {
    const text = readFileSync(join(SRC, "commands", `${command}.ts`), "utf-8");
    expect(text).toContain(".option(...ALLOW_CREDENTIALS_OPTION)");
    expect(text).toContain("await requireCredentialConsent(");
  });

  it("publish does not offer it", () => {
    expect(readFileSync(join(SRC, "commands", "publish.ts"), "utf-8")).not.toContain("ALLOW_CREDENTIALS_OPTION");
  });
});
