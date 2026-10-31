/**
 * The deployer tools of `rotifer agent memory`:
 * listAgentMemory shows metadata only, never the value; deleteSelector and
 * deleteAgentMemory are `delete --key / --category`.
 */
import { describe, expect, it } from "vitest";
import { deleteAgentMemory, deleteSelector, listAgentMemory } from "../../src/commands/agent-memory.js";
import { MemoryError, type NativeMemoryApi } from "../../src/memory/index.js";

const GENE = "v2:" + "a".repeat(64);
const entry = (key: string, category: string, value: string, updatedAt: string) => ({
  entryId: "e".repeat(64),
  category,
  key,
  value: Buffer.from(value).toString("base64"),
  createdBy: GENE,
  lastAccessedBy: null,
  createdAt: "2026-10-30T12:00:00.000Z",
  updatedAt,
  accessPolicy: { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
  retentionPolicy: null,
});

function native(memoryGet: (agentId: string) => unknown): NativeMemoryApi {
  const unused = () => {
    throw new Error("not used by list");
  };
  return {
    memoryGet,
    memoryCreate: unused,
    memorySetDataPolicyRetention: unused,
    memoryRead: unused,
    memoryWrite: unused,
    memoryQuery: unused,
    memoryDelete: unused,
  };
}

const STORED = {
  agentId: "agent-1",
  quota: 1024,
  totalSize: 60,
  entries: [
    entry("pref/lang", "PREFERENCE", "SECRET-zh-CN", "2026-10-30T12:00:01.000Z"),
    entry("pattern/ünï", "PATTERN", "SECRET-ä", "2026-10-30T12:00:03.000Z"),
    entry("cache/x", "CACHE", "SECRET-cache", "2026-10-30T12:00:02.000Z"),
  ],
};

describe("listAgentMemory", () => {
  it("shows key, category, size, creator and update time — newest first — and never the value", () => {
    const listing = listAgentMemory(native(() => STORED), "agent-1");
    expect(listing).toEqual({
      totalSize: 60,
      quota: 1024,
      entries: [
        { key: "pattern/ünï", category: "PATTERN", size: Buffer.byteLength("pattern/ünï") + Buffer.byteLength("SECRET-ä"), createdBy: GENE, updatedAt: "2026-10-30T12:00:03.000Z" },
        { key: "cache/x", category: "CACHE", size: 7 + 12, createdBy: GENE, updatedAt: "2026-10-30T12:00:02.000Z" },
        { key: "pref/lang", category: "PREFERENCE", size: 9 + 12, createdBy: GENE, updatedAt: "2026-10-30T12:00:01.000Z" },
      ],
    });
    const shown = JSON.stringify(listing);
    expect(shown).not.toContain("SECRET");
    for (const e of STORED.entries) expect(shown).not.toContain(e.value);
  });

  it("filters by category; the totals stay the agent's", () => {
    const listing = listAgentMemory(native(() => STORED), "agent-1", "PREFERENCE");
    expect(listing.entries.map((e) => e.key)).toEqual(["pref/lang"]);
    expect(listing).toMatchObject({ totalSize: 60, quota: 1024 });
  });

  it("an agent with no memory yet (created before v0.9.4) lists nothing, without an error", () => {
    const listing = listAgentMemory(
      native(() => {
        throw new Error("MEMORY_NOT_FOUND: agent agent-1 has no memory");
      }),
      "agent-1",
    );
    expect(listing).toEqual({ entries: [], totalSize: 0, quota: null });
  });

  it("any other store error comes through as a MemoryError", () => {
    let caught: unknown;
    try {
      listAgentMemory(
        native(() => {
          throw new Error("database is locked");
        }),
        "agent-1",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).code).toBe("MEMORY_STORAGE_ERROR");
  });

  it("without native memory it is MEMORY_STORAGE_ERROR 'native binding unavailable'", () => {
    expect(() => listAgentMemory(null, "agent-1")).toThrow(/native binding unavailable/);
  });
});

describe("deleteSelector (agent memory delete --key / --category)", () => {
  it("takes exactly one of --key or --category", () => {
    expect(deleteSelector({ key: "pref/lang" })).toEqual({ key: "pref/lang" });
    expect(deleteSelector({ category: "CACHE" })).toEqual({ category: "CACHE" });
  });

  it.each([
    ["neither", {}],
    ["both", { key: "k", category: "CACHE" }],
    ["an empty key", { key: "" }],
    ["a lowercase category", { category: "cache" }],
    ["an unknown category", { category: "EVERYTHING" }],
  ])("refuses %s as MEMORY_INVALID_INPUT", (_what, options) => {
    let caught: unknown;
    try {
      deleteSelector(options);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).code).toBe("MEMORY_INVALID_INPUT");
  });
});

describe("deleteAgentMemory", () => {
  it("passes the selector JSON to memoryAdminDelete and returns the count", () => {
    const calls: unknown[][] = [];
    const n = deleteAgentMemory({ memoryAdminDelete: (agentId, json) => (calls.push([agentId, JSON.parse(json)]), 3) }, "agent-1", { category: "CACHE" });
    expect(n).toBe(3);
    expect(calls).toEqual([["agent-1", { category: "CACHE" }]]);
  });

  it("a missing key comes through as MEMORY_NOT_FOUND; no deployer path is MEMORY_STORAGE_ERROR", () => {
    const notFound = () =>
      deleteAgentMemory(
        {
          memoryAdminDelete: () => {
            throw new Error("MEMORY_NOT_FOUND: no entry");
          },
        },
        "agent-1",
        { key: "k" },
      );
    expect(notFound).toThrow(MemoryError);
    try {
      notFound();
    } catch (err) {
      expect((err as MemoryError).code).toBe("MEMORY_NOT_FOUND");
    }
    for (const native of [null, {}]) {
      try {
        deleteAgentMemory(native, "agent-1", { key: "k" });
        expect.fail("expected MEMORY_STORAGE_ERROR");
      } catch (err) {
        expect((err as MemoryError).code).toBe("MEMORY_STORAGE_ERROR");
      }
    }
  });
});
