/**
 * Snapshots — the undo that installing a gene never had.
 *
 * `rotifer install --force` overwrote a gene in place, and nothing in this CLI
 * could put back what it replaced. Neither could the MCP server, which reaches
 * the same directories: overwriting was the only irreversible operation in
 * Rotifer, and an assistant could reach it.
 *
 * An overwrite now moves the old directory into `<genes>/.snapshots/` first.
 * One snapshot per gene, superseded by the next overwrite of that gene and
 * consumed by a rollback — this undoes the last upgrade, which is the thing
 * people want back. `rotifer versions` already answers what exists upstream.
 *
 * The layout is deliberately identical to @rotifer/mcp-server's, because both
 * write into the same project. A gene overwritten through the MCP server can be
 * rolled back with `rotifer rollback`, and the reverse — snapshots that only
 * one half of the toolchain understood would be a trap rather than a safety
 * net.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SNAPSHOT_DIR = ".snapshots";

export interface SnapshotMeta {
  name: string;
  replacedAt: string;
  replacedBy: string | null;
  replacedVersion: string | null;
}

const snapshotRoot = (genesDir: string): string => join(genesDir, SNAPSHOT_DIR);
const snapshotPath = (genesDir: string, name: string): string => join(snapshotRoot(genesDir), name);
const metaPath = (genesDir: string, name: string): string => join(snapshotRoot(genesDir), `${name}.json`);

function readVersion(geneDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(geneDir, ".cloud-manifest.json"), "utf-8"));
    return typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Move an installed gene aside so an overwrite can be undone.
 *
 * Returns null when there was nothing to snapshot. Throws if the snapshot
 * cannot be written: an overwrite the caller believes is reversible and is not
 * would be worse than refusing to install.
 */
export function snapshotGene(
  genesDir: string,
  name: string,
  replacedBy: string | null = null,
  now: () => Date = () => new Date()
): SnapshotMeta | null {
  const geneDir = join(genesDir, name);
  if (!existsSync(geneDir)) return null;

  const target = snapshotPath(genesDir, name);
  mkdirSync(snapshotRoot(genesDir), { recursive: true });
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });

  const meta: SnapshotMeta = {
    name,
    replacedAt: now().toISOString(),
    replacedBy,
    replacedVersion: readVersion(geneDir),
  };

  renameSync(geneDir, target);
  writeFileSync(metaPath(genesDir, name), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

/** Every gene that can currently be rolled back, newest replacement first. */
export function listSnapshots(genesDir: string): SnapshotMeta[] {
  const root = snapshotRoot(genesDir);
  if (!existsSync(root)) return [];

  let entries: string[];
  try {
    entries = readdirSync(root).filter((e) => {
      try {
        return statSync(join(root, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  return entries
    .map((name) => {
      try {
        return JSON.parse(readFileSync(metaPath(genesDir, name), "utf-8")) as SnapshotMeta;
      } catch {
        // The directory is what makes it restorable; a corrupt sidecar should
        // not strand recoverable files.
        return { name, replacedAt: "", replacedBy: null, replacedVersion: null };
      }
    })
    .sort((a, b) => b.replacedAt.localeCompare(a.replacedAt));
}

export interface RestoreResult {
  name: string;
  restoredTo: string;
  replacedAt: string;
  replacedVersion: string | null;
}

/**
 * Put a snapshot back, discarding whatever currently occupies the gene's
 * directory. The snapshot is consumed: a second rollback would otherwise
 * silently discard the copy the first one restored.
 */
export function restoreGene(genesDir: string, name: string): RestoreResult {
  const source = snapshotPath(genesDir, name);
  if (!existsSync(source)) {
    const available = listSnapshots(genesDir).map((s) => s.name);
    throw new Error(
      available.length
        ? `No snapshot for '${name}'. Available: ${available.join(", ")}.`
        : `No snapshot for '${name}'. Nothing has been overwritten in this project.`
    );
  }

  const meta = listSnapshots(genesDir).find((s) => s.name === name);
  const geneDir = join(genesDir, name);
  if (existsSync(geneDir)) rmSync(geneDir, { recursive: true, force: true });

  renameSync(source, geneDir);
  rmSync(metaPath(genesDir, name), { force: true });

  return {
    name,
    restoredTo: geneDir,
    replacedAt: meta?.replacedAt ?? "",
    replacedVersion: meta?.replacedVersion ?? null,
  };
}

/**
 * Remove an installed gene, keeping a snapshot so the removal is undoable too.
 *
 * Uninstall is the same shape of irreversible act as overwrite, so it gets the
 * same safety net rather than a different one.
 */
export function uninstallGene(genesDir: string, name: string): SnapshotMeta {
  const geneDir = join(genesDir, name);
  if (!existsSync(geneDir)) {
    throw new Error(`Gene '${name}' is not installed at ${geneDir}.`);
  }
  const meta = snapshotGene(genesDir, name);
  if (!meta) {
    // snapshotGene only returns null when the directory is absent, which the
    // check above rules out. Refuse rather than delete unrecoverably.
    throw new Error(`Could not snapshot '${name}' before removing it; nothing was removed.`);
  }
  return meta;
}
