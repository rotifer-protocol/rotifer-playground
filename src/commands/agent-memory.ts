/**
 * `rotifer agent memory` — the deployer's view of an agent's memory
 *. PREFERENCE entries are never evicted
 * for quota, so a full memory needs a person to look and clean up.
 *
 * `list` shows what is stored without the values: key, category, size,
 * the creating gene and the last update. Values can hold user data (§30), so
 * they are never printed. `delete` removes one key or a whole category
 * through rotifer-napi's deployer path (memoryAdminDelete), which audits each
 * entry with actor "deployer". Both work on rotifer-napi's store in the
 * project (`.rotifer/playground.db`); the deployer owns the agent, so gene
 * access scopes do not apply. There is no edit command.
 */
import { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { geneIdV2 } from "../utils/binding.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { findAgent } from "./agent-run.js";
import { formatQuota } from "./agent-create.js";
import { asMemoryError, type NativeMemoryApi } from "../memory/index.js";
import { projectNativeMemory } from "../memory/host.js";
import { entrySize } from "../memory/codec.js";
import { MemoryError, isMemoryCategory, type MemoryCategory, type MemoryEntryJson } from "../memory/types.js";

/** One stored entry, as the deployer sees it: no value. */
export interface MemoryListing {
  key: string;
  category: MemoryCategory;
  /** Bytes the entry counts against the quota (UTF-8 key + value). */
  size: number;
  createdBy: string;
  updatedAt: string;
}

export interface AgentMemoryListing {
  entries: MemoryListing[];
  /** All entries, whatever the category filter. */
  totalSize: number;
  quota: number | null;
}

/**
 * What `agent memory list` shows. An agent created before v0.9.4 has no
 * memory yet: an empty listing, not an error. Without native memory there is
 * no store to read: MEMORY_STORAGE_ERROR.
 */
export function listAgentMemory(native: NativeMemoryApi | null, agentId: string, category?: MemoryCategory): AgentMemoryListing {
  if (!native) {
    throw new MemoryError("MEMORY_STORAGE_ERROR", "native binding unavailable: agent memory needs the rotifer native addon on this platform");
  }
  let memory: { entries: MemoryEntryJson[]; totalSize: number; quota: number };
  try {
    memory = native.memoryGet(agentId) as typeof memory;
  } catch (err) {
    const e = asMemoryError(err);
    if (e.code === "MEMORY_NOT_FOUND") return { entries: [], totalSize: 0, quota: null };
    throw e;
  }
  const entries = memory.entries
    .filter((e) => category === undefined || e.category === category)
    .map((e) => ({
      key: e.key,
      category: e.category,
      size: entrySize(e.key, Buffer.from(e.value, "base64")),
      createdBy: e.createdBy,
      updatedAt: e.updatedAt,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.key < b.key ? -1 : 1));
  return { entries, totalSize: memory.totalSize, quota: memory.quota };
}

/**
 * How a creating gene is shown: its name when a gene in the project has that
 * id, otherwise (an older version, a gene since removed) a short id prefix.
 */
export function creatorLabels(genesRoot: string): (geneId: string) => string {
  const names = new Map<string, string>();
  if (existsSync(genesRoot)) {
    for (const name of readdirSync(genesRoot)) {
      const result = geneIdV2(genesRoot, name);
      if ("id" in result) names.set(result.id, name);
    }
  }
  return (geneId) => names.get(geneId) ?? `${geneId.slice(0, 15)}…`;
}

/** Which entries `agent memory delete` removes: one key, or one category. */
export type MemoryDeleteSelector = { key: string } | { category: MemoryCategory };

/** rotifer-napi's deployer delete: the number of entries removed. */
export interface NativeAdminApi {
  memoryAdminDelete(agentId: string, selectorJson: string): unknown;
}

/**
 * The selector from `--key` / `--category`: exactly one of them. A bad one
 * is MEMORY_INVALID_INPUT, before anything is touched.
 */
export function deleteSelector(options: { key?: string; category?: string }): MemoryDeleteSelector {
  const hasKey = options.key !== undefined;
  const hasCategory = options.category !== undefined;
  if (hasKey === hasCategory) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "give exactly one of --key or --category");
  }
  if (hasKey) {
    if (options.key === "") throw new MemoryError("MEMORY_INVALID_INPUT", "--key must not be empty");
    return { key: options.key! };
  }
  if (!isMemoryCategory(options.category)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown memory category '${options.category}'; use one of PREFERENCE, PATTERN, CONTEXT, CACHE`);
  }
  return { category: options.category };
}

/** Delete as the deployer; returns how many entries went. A missing key is MEMORY_NOT_FOUND. */
export function deleteAgentMemory(native: Partial<NativeAdminApi> | null, agentId: string, selector: MemoryDeleteSelector): number {
  if (!native || typeof native.memoryAdminDelete !== "function") {
    throw new MemoryError("MEMORY_STORAGE_ERROR", "native binding unavailable: agent memory needs the rotifer native addon on this platform");
  }
  try {
    return Number(native.memoryAdminDelete(agentId, JSON.stringify(selector)));
  } catch (err) {
    throw asMemoryError(err);
  }
}

/** The agent named on the command line, or exit with E0050. */
function agentOrExit(root: string, agentName: string): { id: string } {
  const agent = findAgent(root, agentName);
  if (!agent) {
    display.rustStyleError({
      code: "E0050",
      message: `Agent '${agentName}' not found`,
      suggestion: "List agents: rotifer agent list",
    });
    process.exit(1);
  }
  return agent;
}

const memoryListCommand = new Command("list")
  .description("List an agent's memory entries: key, category, size, creating gene, last update (values are not shown)")
  .argument("<agent-name>", "agent name")
  .option("-c, --category <category>", "only this category: PREFERENCE, PATTERN, CONTEXT or CACHE")
  .addHelpText(
    "after",
    ["", "Examples:", "  $ rotifer agent memory list my-agent", "  $ rotifer agent memory list my-agent --category PREFERENCE"].join("\n"),
  )
  .action((agentName: string, options: { category?: string }) => {
    const root = requireProjectRoot();
    const agent = agentOrExit(root, agentName);
    if (options.category !== undefined && !isMemoryCategory(options.category)) {
      display.rustStyleError({
        code: "E0040",
        message: `unknown memory category '${options.category}'`,
        suggestion: "Use one of PREFERENCE, PATTERN, CONTEXT, CACHE",
      });
      process.exit(1);
    }

    let listing: AgentMemoryListing;
    try {
      listing = listAgentMemory(projectNativeMemory(root), agent.id, options.category as MemoryCategory | undefined);
    } catch (err) {
      const e = asMemoryError(err);
      display.rustStyleError({ code: "E0040", message: `${e.code}: ${e.message}` });
      process.exit(1);
    }

    display.header(`Agent Memory: ${agentName}`);
    const creator = creatorLabels(join(root, loadConfig(root).genes_dir));
    if (listing.entries.length === 0) {
      display.info(options.category ? `No ${options.category} entries` : "No memory entries yet");
    } else {
      display.table(
        listing.entries.map((e) => ({ ...e, createdBy: creator(e.createdBy) })),
        [
          { key: "key", label: "Key" },
          { key: "category", label: "Category", width: 12 },
          { key: "size", label: "Size", align: "right", format: (v) => formatQuota(Number(v)) },
          { key: "createdBy", label: "Created by" },
          { key: "updatedAt", label: "Updated" },
        ],
      );
    }
    const quota = listing.quota === null ? "no memory created yet" : `${formatQuota(listing.totalSize)} of ${formatQuota(listing.quota)} used`;
    display.hint(`${listing.entries.length} entr${listing.entries.length === 1 ? "y" : "ies"} shown · ${quota}`);
  });

const memoryDeleteCommand = new Command("delete")
  .description("Delete an agent's memory entries as the deployer: one key, or every entry of one category")
  .argument("<agent-name>", "agent name")
  .option("-k, --key <key>", "the entry with this key")
  .option("-c, --category <category>", "every entry of this category: PREFERENCE, PATTERN, CONTEXT or CACHE")
  .addHelpText(
    "after",
    [
      "",
      "Give exactly one of --key or --category. PREFERENCE entries are never evicted for quota, so this is how a full memory is cleared.",
      "",
      "Examples:",
      "  $ rotifer agent memory delete my-agent --key preference-demo/ada/language",
      "  $ rotifer agent memory delete my-agent --category CACHE",
    ].join("\n"),
  )
  .action((agentName: string, options: { key?: string; category?: string }) => {
    const root = requireProjectRoot();
    const agent = agentOrExit(root, agentName);
    let deleted: number;
    try {
      deleted = deleteAgentMemory(projectNativeMemory(root) as Partial<NativeAdminApi> | null, agent.id, deleteSelector(options));
    } catch (err) {
      const e = asMemoryError(err);
      display.rustStyleError({
        code: "E0040",
        message: `${e.code}: ${e.message}`,
        suggestion: e.code === "MEMORY_NOT_FOUND" ? `See what is stored: rotifer agent memory list ${agentName}` : undefined,
      });
      process.exit(1);
    }
    display.success(`Deleted ${deleted} entr${deleted === 1 ? "y" : "ies"} from ${agentName}'s memory`);
  });

export const agentMemoryCommand = new Command("memory")
  .description("Look at and clean up an agent's memory (deployer tools)")
  .addCommand(memoryListCommand)
  .addCommand(memoryDeleteCommand);
