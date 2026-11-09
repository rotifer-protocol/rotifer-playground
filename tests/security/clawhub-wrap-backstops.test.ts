import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The layers behind the zip reader. tests/e2e/clawhub-wrap-hostile.test.ts
 * proves a hostile package is refused, but the reader stops it first, so
 * these would never run there. Each is tested with the layer before it gone.
 */
vi.mock("../../src/utils/zip-safety.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/zip-safety.js")>()),
  assertSafeZip: () => {},
}));
const fetchPackage = vi.fn();
vi.mock("../../src/utils/clawhub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/clawhub-client.js")>()),
  fetchClawHubPackage: (...args: unknown[]) => fetchPackage(...args),
}));

describe("behind the zip reader", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rotifer-backstop-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("a link the reader missed is caught after extraction", async () => {
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "SKILL.md"), "x");
    symlinkSync("/etc/hosts", join(pkg, "notes.md"));
    const zipPath = join(dir, "p.zip");
    execFileSync("zip", ["-q", "-r", "-y", zipPath, "."], { cwd: pkg });
    fetchPackage.mockResolvedValue(readFileSync(zipPath));

    const { downloadAndExtract } = await import("../../src/commands/wrap.js");
    await expect(downloadAndExtract(`backstop-${Date.now()}`, {})).rejects.toThrow(/symbolic link/);
  });

  it("copying refuses a link in the package instead of following it", async () => {
    const secret = join(dir, "secret");
    writeFileSync(secret, "SECRET");
    const pkg = join(dir, "pkg");
    const gene = join(dir, "gene");
    mkdirSync(pkg);
    mkdirSync(gene);
    symlinkSync(secret, join(pkg, "notes.md"));

    const { copyPackageFiles } = await import("../../src/commands/wrap.js");
    expect(() => copyPackageFiles(pkg, gene)).toThrow(/symbolic link/);
    expect(existsSync(join(gene, "notes.md"))).toBe(false);
  });

  it("copying refuses to write through a link already in the gene directory", async () => {
    const target = join(dir, "target");
    writeFileSync(target, "ORIGINAL");
    const pkg = join(dir, "pkg");
    const gene = join(dir, "gene");
    mkdirSync(pkg);
    mkdirSync(gene);
    writeFileSync(join(pkg, "notes.md"), "OVERWRITTEN");
    symlinkSync(target, join(gene, "notes.md"));

    const { copyPackageFiles } = await import("../../src/commands/wrap.js");
    expect(() => copyPackageFiles(pkg, gene)).toThrow(/symbolic link/);
    expect(readFileSync(target, "utf-8")).toBe("ORIGINAL");
  });
});
