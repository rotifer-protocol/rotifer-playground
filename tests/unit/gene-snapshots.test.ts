import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  snapshotGene,
  restoreGene,
  listSnapshots,
  uninstallGene,
} from "../../src/utils/gene-snapshots.js";

// A real filesystem, not mocks: the claim under test is that files genuinely
// survive being overwritten, and a mocked fs would pass while they were lost.
let genesDir: string;

function installGene(name: string, marker: string, version?: string): void {
  const dir = join(genesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify({ name, marker }));
  writeFileSync(join(dir, "index.ts"), `// ${marker}\n`);
  if (version) {
    writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ version }));
  }
}

const markerOf = (dir: string): string =>
  JSON.parse(readFileSync(join(dir, "phenotype.json"), "utf-8")).marker;

beforeEach(() => {
  genesDir = join(mkdtempSync(join(tmpdir(), "rotifer-cli-snap-")), "genes");
  mkdirSync(genesDir, { recursive: true });
});

afterEach(() => {
  rmSync(genesDir, { recursive: true, force: true });
});

describe("snapshotGene", () => {
  it("moves the installed copy aside and records what it was", () => {
    installGene("formatter", "v1", "1.0.0");

    const meta = snapshotGene(genesDir, "formatter", "gene-abc");

    expect(meta).toMatchObject({ name: "formatter", replacedBy: "gene-abc", replacedVersion: "1.0.0" });
    expect(existsSync(join(genesDir, "formatter"))).toBe(false);
    expect(markerOf(join(genesDir, ".snapshots", "formatter"))).toBe("v1");
  });

  it("returns null when nothing is installed under that name", () => {
    expect(snapshotGene(genesDir, "never-installed")).toBeNull();
  });

  it("keeps one snapshot per gene", () => {
    installGene("formatter", "v1");
    snapshotGene(genesDir, "formatter");
    installGene("formatter", "v2");
    snapshotGene(genesDir, "formatter");

    expect(markerOf(join(genesDir, ".snapshots", "formatter"))).toBe("v2");
    expect(listSnapshots(genesDir)).toHaveLength(1);
  });
});

describe("restoreGene", () => {
  it("puts every file of the replaced copy back", () => {
    installGene("formatter", "original", "1.0.0");
    snapshotGene(genesDir, "formatter");
    installGene("formatter", "replacement", "2.0.0");

    restoreGene(genesDir, "formatter");

    const dir = join(genesDir, "formatter");
    expect(markerOf(dir)).toBe("original");
    expect(readFileSync(join(dir, "index.ts"), "utf-8")).toContain("original");
    expect(JSON.parse(readFileSync(join(dir, ".cloud-manifest.json"), "utf-8")).version).toBe("1.0.0");
  });

  it("consumes the snapshot so a second rollback cannot discard what the first restored", () => {
    installGene("formatter", "original");
    snapshotGene(genesDir, "formatter");
    installGene("formatter", "replacement");

    restoreGene(genesDir, "formatter");

    expect(() => restoreGene(genesDir, "formatter")).toThrow(/No snapshot/);
    expect(markerOf(join(genesDir, "formatter"))).toBe("original");
  });

  it("names what is available when asked for the wrong gene", () => {
    installGene("alpha", "a1");
    snapshotGene(genesDir, "alpha");

    expect(() => restoreGene(genesDir, "beta")).toThrow(/Available: alpha/);
  });

  it("says nothing has been overwritten when there is no snapshot at all", () => {
    expect(() => restoreGene(genesDir, "anything")).toThrow(/Nothing has been overwritten/);
  });
});

describe("uninstallGene", () => {
  it("removes the gene but leaves it restorable", () => {
    installGene("formatter", "v1", "1.0.0");

    const meta = uninstallGene(genesDir, "formatter");

    expect(meta.replacedVersion).toBe("1.0.0");
    expect(existsSync(join(genesDir, "formatter"))).toBe(false);
    expect(listSnapshots(genesDir).map((s) => s.name)).toEqual(["formatter"]);

    restoreGene(genesDir, "formatter");
    expect(markerOf(join(genesDir, "formatter"))).toBe("v1");
  });

  it("refuses when the gene is not installed, rather than reporting a no-op success", () => {
    expect(() => uninstallGene(genesDir, "absent")).toThrow(/is not installed/);
  });
});

describe("interoperability with @rotifer/mcp-server", () => {
  it("reads a snapshot laid out by the MCP server", () => {
    // Both write into the same project. The MCP server produces exactly this
    // layout; if the CLI could not read it, a gene overwritten through an
    // assistant would be unrecoverable from the terminal.
    const snapDir = join(genesDir, ".snapshots", "formatter");
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, "phenotype.json"), JSON.stringify({ name: "formatter", marker: "from-mcp" }));
    writeFileSync(
      join(genesDir, ".snapshots", "formatter.json"),
      JSON.stringify({ name: "formatter", replacedAt: "2026-08-15T00:00:00.000Z", replacedBy: "gene-x", replacedVersion: "1.2.3" })
    );

    expect(listSnapshots(genesDir)).toEqual([
      { name: "formatter", replacedAt: "2026-08-15T00:00:00.000Z", replacedBy: "gene-x", replacedVersion: "1.2.3" },
    ]);

    const restored = restoreGene(genesDir, "formatter");
    expect(restored.replacedVersion).toBe("1.2.3");
    expect(markerOf(join(genesDir, "formatter"))).toBe("from-mcp");
  });
});
