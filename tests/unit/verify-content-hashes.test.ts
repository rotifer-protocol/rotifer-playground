import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../../scripts/verify-content-hashes.js";
import { contentHash } from "../../src/utils/content-hash.js";

/**
 * scripts/verify-content-hashes.ts must never write a hash into
 * phenotype.json. Its old `--fix` wrote `contentHash` into the file, the same
 * kind of self-hash that left three stored rows unreproducible (ADR-341).
 */

describe("scripts/verify-content-hashes.ts", () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const output = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.join(" ")).join("\n");

  function writePhenotype(name: string, phenotype: Record<string, unknown>): string {
    const dir = join(root, "genes", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "phenotype.json");
    writeFileSync(path, JSON.stringify(phenotype, null, 2) + "\n");
    return path;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "verify-content-hashes-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("H3-b: --fix leaves every phenotype.json byte-for-byte unchanged and adds no hash field", () => {
    const clean = writePhenotype("clean", { domain: "d", version: "1.0.0" });
    const stale = writePhenotype("stale", { domain: "d", version: "1.0.0", content_hash: "deadbeef" });
    const before = [readFileSync(clean), readFileSync(stale)];

    const code = main(["--fix"], root);

    expect(code).toBe(2);
    expect(output()).toContain("--fix was removed");
    expect(readFileSync(clean).equals(before[0])).toBe(true);
    expect(readFileSync(stale).equals(before[1])).toBe(true);
    const cleanNow = JSON.parse(readFileSync(clean, "utf-8"));
    expect(cleanNow).not.toHaveProperty("contentHash");
    expect(cleanNow).not.toHaveProperty("content_hash");
  });

  it("reports the hash publish would send, without writing", () => {
    const path = writePhenotype("clean", { domain: "d", version: "1.0.0" });
    const before = readFileSync(path);

    expect(main([], root)).toBe(0);
    expect(output()).toContain(contentHash({ domain: "d", version: "1.0.0" }));
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("flags a phenotype that stores its own hash, under either field name", () => {
    writePhenotype("a", { domain: "d", contentHash: "x" });
    writePhenotype("b", { domain: "d", content_hash: "y" });

    expect(main([], root)).toBe(1);
    expect(output()).toMatch(/SELF-HASH\s+a: phenotype.json stores contentHash/);
    expect(output()).toMatch(/SELF-HASH\s+b: phenotype.json stores content_hash/);
  });
});
