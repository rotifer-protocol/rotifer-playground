/**
 * AgentMemory lifecycle lines in `<root>/.rotifer/audit.jsonl`, in
 * rotifer-core's MemoryAuditEvent shape (memory/events.rs), so a reader sees
 * one format whichever side wrote the line.
 *
 * No key and no value: memory can hold user data (§30); the entryId
 * identifies the entry. Audit is written whatever ROTIFER_TELEMETRY says
 *. A failed audit write is MEMORY_STORAGE_ERROR, and the
 * operation it describes does not happen.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryError, type MemoryCategory, type MemoryErrorCode } from "./types.js";

export type MemoryAuditAction =
  | "memory_created"
  | "write"
  | "update"
  | "delete"
  | "evict"
  | "quota_rejected"
  | "access_denied"
  /** Removed because its retention ran out. */
  | "expired"
  /** The agent's DataPolicy retention was set. */
  | "retention_changed";

export interface MemoryAuditLine {
  ts: string;
  kind: "agent_memory";
  action: MemoryAuditAction;
  agentId: string;
  entryId: string | null;
  category: MemoryCategory | null;
  /** The gene whose call caused it; null for the deployer / CLI. */
  geneId: string | null;
  /** Bytes added (positive) or freed (negative) by this event. */
  sizeDelta: number;
  /** AgentMemory total after the event. */
  totalSize: number;
  quota: number;
  error: MemoryErrorCode | null;
}

export type MemoryAuditSink = (line: MemoryAuditLine) => void;

/** Appends to `<root>/.rotifer/audit.jsonl`, created owner-only (0600). */
export function fileAuditSink(root: string): MemoryAuditSink {
  const path = join(root, ".rotifer", "audit.jsonl");
  return (line) => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch (err) {
      throw new MemoryError("MEMORY_STORAGE_ERROR", `could not write the audit log: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    }
  };
}
