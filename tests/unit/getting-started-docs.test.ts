/**
 * The getting-started tutorial has to compile as written.
 *
 * #447: step 3's gene exported `async function express`, and step 6 compiles
 * it to Native WASM, which Javy/QuickJS refuses (E0025). `rotifer init`'s own
 * template has been synchronous since #57; the tutorial had not followed.
 * Checked with the same detector `rotifer compile` uses.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectAsyncExpress } from "../../src/utils/javy-compiler.js";

const TUTORIALS = ["docs/getting-started.md", "docs/getting-started.zh.md"];

/** Every ```typescript block that defines express. */
function expressBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```(?:typescript|ts)\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((code) => /\bexpress\b/.test(code));
}

describe.each(TUTORIALS)("%s", (path) => {
  const markdown = readFileSync(join(process.cwd(), path), "utf-8");

  it("defines a gene", () => {
    expect(expressBlocks(markdown).length).toBeGreaterThan(0);
  });

  it("exports a synchronous express, which compile accepts", () => {
    expect(expressBlocks(markdown).map(detectAsyncExpress)).toEqual(
      expressBlocks(markdown).map(() => null),
    );
  });
});
