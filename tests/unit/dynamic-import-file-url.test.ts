/**
 * Dynamic imports of a path go through `pathToFileURL(…).href` (T-112).
 *
 * `import()` takes a URL specifier, not a path. On POSIX an absolute path
 * happens to work; on Windows `C:\genes\x\index.ts` parses as a URL whose
 * scheme is `c:`, and Node's ESM loader refuses it
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME). `rotifer run`'s Node.js fallback imported
 * the gene's source path raw, so it could not run any gene on Windows, while
 * `test`, `agent run`, `hello` and the testsuite gate already converted.
 *
 * The CLI cannot be run on Windows here, so this pins both halves: what Node
 * does with each specifier, and that no `import()` in src passes anything but
 * a string literal or a `pathToFileURL(…).href`.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = join(process.cwd(), "src");
const DRIVE_LETTER_PATH = "C:\\genes\\demo\\index.ts";

/** Node's own answer to `import(specifier)`, outside vitest's module runner. */
function nodeImportError(specifier: string): string {
  const script =
    `import(${JSON.stringify(specifier)})` +
    `.then(() => console.log("loaded"), (e) => console.log(e.code))`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" }).trim();
}

/**
 * Every `import(<argument>)` in a file whose argument is not a string literal.
 * Comment lines are skipped: prose like "before import():" is not a call.
 */
function computedImports(file: string): string[] {
  const source = file
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
  const found: string[] = [];
  const pattern = /\bimport\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    const argument = source.slice(start, i - 1).trim();
    const isPlainLiteral = /^(["'])[^"']*\1$/.test(argument) || /^`[^`$]*`$/.test(argument);
    if (!isPlainLiteral) found.push(argument);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("dynamic imports of a path use a file: URL", () => {
  it("Node refuses a drive-letter path as an import specifier", () => {
    expect(nodeImportError(DRIVE_LETTER_PATH)).toBe("ERR_UNSUPPORTED_ESM_URL_SCHEME");
  });

  it("and pathToFileURL turns it into the file: URL the loader takes", () => {
    const href = pathToFileURL(DRIVE_LETTER_PATH, { windows: true }).href;
    expect(href).toBe("file:///C:/genes/demo/index.ts");
    // Not found, which is a different error: the scheme was accepted.
    expect(nodeImportError(href)).toBe("ERR_MODULE_NOT_FOUND");
  });

  it("no import() in src passes a raw path", () => {
    const raw = sourceFiles(SRC).flatMap((file) =>
      computedImports(readFileSync(file, "utf-8"))
        .filter((argument) => !/^pathToFileURL\([\s\S]+\)\.href$/.test(argument))
        .map((argument) => `${relative(process.cwd(), file)}: import(${argument})`),
    );
    expect(raw).toEqual([]);
  });
});
