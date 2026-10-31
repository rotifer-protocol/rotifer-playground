/**
 * AgentMemory SDK (spec §38, v0.9.4) — what a gene author uses: the types,
 * the GeneMemoryAccess interface a gene gets as ctx.memory, MemoryError and
 * its codes, and the SDK layer over a store. Published as
 * `@rotifer/playground/memory`; nothing here needs Node's types.
 *
 * The CLI's side — opening the agent's store in the project, the WASM
 * path's binding, the throwaway memory of `rotifer test` — is in ./host.ts,
 * which is not part of that surface.
 */
import type { GeneMemoryAccess } from "./access.js";
import { accessDeniedEvent, type MemoryOperation, type MemoryTelemetrySink } from "./telemetry.js";
import { MemoryError } from "./types.js";

export * from "./types.js";
export * from "./codec.js";
export * from "./access.js";
export * from "./data-policy.js";
export * from "./telemetry.js";
export * from "./audit.js";
// The store interface and the napi adapter; the JSON test double stays in
// ./backend.ts for tests and is not part of this module's surface.
export {
  NapiMemoryBackend,
  asMemoryError,
  hasNativeMemory,
  type AgentMemoryConfig,
  type MemoryBackend,
  type MemoryCaller,
  type MemoryWriteRequest,
  type NativeMemoryApi,
} from "./backend.js";

/** A GeneMemoryAccess whose every call throws `code` with `message`. */
function refusingMemory(code: "MEMORY_ACCESS_DENIED" | "MEMORY_STORAGE_ERROR", message: string): GeneMemoryAccess {
  const refuse = (): never => {
    throw new MemoryError(code, message);
  };
  return { readMemory: refuse, writeMemory: refuse, queryMemory: refuse, deleteMemory: refuse };
}

const NO_AGENT_CONTEXT = "no agent context: this gene is not running inside an agent, so it has no agent memory";

/**
 * The memory a gene gets when it runs with no agent around it (`rotifer run`
 * of a single gene): every call is MEMORY_ACCESS_DENIED with a message that
 * starts "no agent context". `ctx.memory` is never undefined,
 * so a gene meets a clear error, not a TypeError on `undefined`.
 *
 * With a `telemetry` sink each refusal is also a §17 MEMORY_ACCESS_DENIED
 * event — agentId null, no entry, `geneId` when the gene has a v2 id — and
 * nothing else: there is no agent's memory to audit it in (as
 * rotifer-core records a WASM gene's).
 */
export function noAgentMemory(options: { telemetry?: MemoryTelemetrySink; geneId?: string | null } = {}): GeneMemoryAccess {
  const refuse =
    (operation: MemoryOperation) =>
    (): never => {
      options.telemetry?.(accessDeniedEvent({ agentId: null, geneId: options.geneId ?? null, entryId: null, operation, message: NO_AGENT_CONTEXT }));
      throw new MemoryError("MEMORY_ACCESS_DENIED", NO_AGENT_CONTEXT);
    };
  return { readMemory: refuse("read"), writeMemory: refuse("write"), queryMemory: refuse("query"), deleteMemory: refuse("delete") };
}

/** Every call is MEMORY_STORAGE_ERROR "native binding unavailable". */
export function memoryUnavailable(): GeneMemoryAccess {
  return refusingMemory("MEMORY_STORAGE_ERROR", "native binding unavailable: agent memory needs the rotifer native addon on this platform");
}
