/**
 * §17 telemetry for AgentMemory access denials (spec §38.2: "权限违规记录到
 * §17 遥测系统").
 *
 * One §17.3 TelemetryEvent per line in `<root>/.rotifer/telemetry.jsonl`, in
 * the shape rotifer-core writes (memory/events.rs MemoryTelemetryEvent), so a
 * reader sees one format whichever binding denied the call. §17.3 has no
 * memory event type, so `MEMORY_ACCESS_DENIED` carries `bindingExtension`.
 * Local only, and it honours the same opt-out as the rest of the CLI's
 * telemetry: ROTIFER_TELEMETRY=0 (or DO_NOT_TRACK) writes nothing here
 *. The audit line for the same denial is written
 * regardless (audit.ts). No key and no value: the entryId identifies the
 * entry.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { telemetryOptedOutByEnv } from "../telemetry/consent.js";

/** The operation names rotifer-core writes in metadata.operation. */
export type MemoryOperation = "read" | "write" | "query" | "delete";

export interface MemoryTelemetryEvent {
  eventType: "MEMORY_ACCESS_DENIED";
  bindingExtension: true;
  traceContext: null;
  /** null when the calling gene has no usable v2 id. */
  geneId: string | null;
  timestamp: string;
  duration: null;
  resourceUsage: null;
  result: { FAILURE: { errorCode: "MEMORY_ACCESS_DENIED"; message: string } };
  /** agentId null outside any agent; entryId null when the call named no key. */
  metadata: { agentId: string | null; entryId: string | null; operation: MemoryOperation };
}

export type MemoryTelemetrySink = (event: MemoryTelemetryEvent) => void;

export function fileTelemetrySink(root: string, env: Record<string, string | undefined> = process.env): MemoryTelemetrySink {
  const path = join(root, ".rotifer", "telemetry.jsonl");
  return (event) => {
    if (telemetryOptedOutByEnv(env)) return;
    // Telemetry is best-effort: the denial it reports stands, and the audit
    // line (which is not best-effort) already recorded it.
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, JSON.stringify(event) + "\n", { mode: 0o600 });
    } catch {
      /* not a reason to fail the call */
    }
  };
}

export function accessDeniedEvent(args: {
  agentId: string | null;
  geneId: string | null;
  entryId: string | null;
  operation: MemoryOperation;
  message: string;
  timestamp?: string;
}): MemoryTelemetryEvent {
  return {
    eventType: "MEMORY_ACCESS_DENIED",
    bindingExtension: true,
    traceContext: null,
    geneId: args.geneId,
    timestamp: args.timestamp ?? new Date().toISOString(),
    duration: null,
    resourceUsage: null,
    result: { FAILURE: { errorCode: "MEMORY_ACCESS_DENIED", message: args.message } },
    metadata: { agentId: args.agentId, entryId: args.entryId, operation: args.operation },
  };
}
