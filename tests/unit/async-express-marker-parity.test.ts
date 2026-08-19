import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_ASYNC_EXPRESS_MARKERS } from "../../src/arena/invalidation-criteria.js";
import { detectAsyncExpress } from "../../src/utils/javy-compiler.js";

/**
 * The same defect is now recognised in three places: the compiler refuses to
 * build it, the Rust sandbox refuses to run it, and the Arena audit refuses to
 * rank it. Three copies of one rule is how a rule drifts — and drift here has a
 * specific, bad shape: the sandbox refuses a gene the leaderboard still ranks,
 * which is precisely the contradiction ADR-319 exists to remove.
 *
 * So this test reads the Rust source and fails if the two artifact-level lists
 * stop matching. It is deliberately brittle: a marker added on one side should
 * break the build, not quietly widen the gap.
 */

const RUST_SANDBOX = join(
  __dirname,
  "..",
  "..",
  "crates",
  "rotifer-core",
  "src",
  "sandbox",
  "wasmtime_sandbox.rs"
);

function rustMarkers(): string[] {
  const src = readFileSync(RUST_SANDBOX, "utf-8");
  const decl = src.match(/const ASYNC_EXPRESS_MARKERS:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/);
  if (!decl) {
    throw new Error(
      `ASYNC_EXPRESS_MARKERS not found in ${RUST_SANDBOX}. If it was renamed or moved, update this test — do not delete it.`
    );
  }
  return [...decl[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

describe("async-express markers stay in step with the runtime", () => {
  it("matches the Rust sandbox list exactly", () => {
    expect([...ARTIFACT_ASYNC_EXPRESS_MARKERS].sort()).toEqual(rustMarkers().sort());
  });

  it("declares the arity the Rust const claims", () => {
    const src = readFileSync(RUST_SANDBOX, "utf-8");
    const arity = src.match(/const ASYNC_EXPRESS_MARKERS:\s*\[&str;\s*(\d+)\]/);
    expect(Number(arity?.[1])).toBe(ARTIFACT_ASYNC_EXPRESS_MARKERS.length);
  });

  /**
   * The compiler's source-level guard carries a third pattern that matches a
   * TypeScript return-type annotation. Types do not survive compilation, so it
   * has no artifact-level counterpart — by construction, not by omission. This
   * pins that reasoning: if the annotation ever did reach the artifact, the
   * artifact list would be missing a real case.
   */
  it("confirms the source-only pattern really is source-only", () => {
    const annotated = "export function express(input: X): Promise<Y> { return f(input); }";
    expect(detectAsyncExpress(annotated)).not.toBeNull();

    // What esbuild emits for the above: the annotation is gone, and so is any
    // marker the artifact scan could have keyed on.
    const compiled = "export function express(input) { return f(input); }";
    expect(detectAsyncExpress(compiled)).toBeNull();
    for (const marker of ARTIFACT_ASYNC_EXPRESS_MARKERS) {
      expect(compiled).not.toContain(marker);
    }
  });

  it("still catches both shapes the compiler rejects at source level", () => {
    expect(detectAsyncExpress("export async function express(i) {}")).not.toBeNull();
    expect(detectAsyncExpress("const express = async (i) => ({});")).not.toBeNull();
  });
});
