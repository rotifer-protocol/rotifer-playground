/**
 * A committed artifact must not contradict its own source.
 *
 * `bundled-genes-compilable.test.ts` reads the corpus statically and asserts
 * that every source *would* compile clean. It never opens the `.wasm` files
 * checked in beside them, and on 2026-08-19 all six tracked artifacts still
 * carried `async function express` while all six sources had been synchronous
 * since #216. The guard was green the whole time.
 *
 * That is not a cosmetic drift. `rotifer run particle-barneshut` against the
 * committed artifact fails outright — the sandbox refuses it — and an Arena
 * submission scored 0/3. Anyone cloning the repo and publishing without a
 * fresh compile would have re-uploaded exactly the artifact the invalidation
 * criteria disqualified.
 *
 * The markers are the same list the runtime rejects on, kept aligned with
 * `wasmtime_sandbox.rs` by `async-express-marker-parity.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ASYNC_EXPRESS_MARKERS = ["async function express", "express = async"] as const;

/** Only artifacts under version control. Local build output is not the repo's problem. */
function trackedWasmFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "genes/*/gene.wasm", "genes/*/gene.ir.wasm"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function containsMarker(file: string): string | null {
  // latin1 so every byte maps to a character — the JS source sits in the
  // artifact as raw bytes and utf-8 decoding would mangle the search.
  const text = readFileSync(join(ROOT, file), "latin1");
  return ASYNC_EXPRESS_MARKERS.find((m) => text.includes(m)) ?? null;
}

describe("committed WASM artifacts", () => {
  const files = trackedWasmFiles();

  it("there are tracked artifacts to check", () => {
    // If this ever hits zero the suite below would pass vacuously, which is the
    // failure mode this whole file exists to catch.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s carries no async-express marker", (file) => {
    const marker = containsMarker(file);
    expect(
      marker,
      `${file} contains "${marker}". The source was fixed but the artifact was not recompiled — ` +
        `run: rotifer compile ${file.split("/")[1]}`,
    ).toBeNull();
  });

  it("the scan actually reads the JavaScript inside the artifact", () => {
    // Control. Finding no async marker means nothing unless the search can see
    // the embedded source at all — an empty or unreadable read would also
    // report "clean".
    const readable = files.filter((f) => readFileSync(join(ROOT, f), "latin1").includes("function express"));
    expect(readable.length).toBeGreaterThan(0);
  });
});
