/**
 * The CLI's side of AgentMemory (spec §38.2): opening an agent's memory in
 * rotifer-napi's store and binding it to one gene, for the Node path
 * (ctx.memory) and the WASM path (a binding + memoryContext).
 *
 * Memory belongs to the agent (§38.1): it is keyed by the agent id, and
 * nothing here looks at the agent's genome, so replacing genes neither
 * deletes nor rewrites it.
 *
 * The store is rotifer-napi's, in the project's `.rotifer/playground.db`
 *. Without the native binding there is no memory: every call
 * fails with MEMORY_STORAGE_ERROR "native binding unavailable". There is no
 * fallback store.
 *
 * Not part of `@rotifer/playground/memory`: these signatures carry the
 * native binding's types.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { geneIdV2, tryLoadBinding, type NativeBinding } from "../utils/binding.js";
import { createGeneMemoryAccess, type GeneMemoryAccess } from "./access.js";
import { fileAuditSink, type MemoryAuditSink } from "./audit.js";
import { NapiMemoryBackend, asMemoryError, hasNativeMemory, type MemoryBackend, type NativeMemoryApi } from "./backend.js";
import { DEFAULT_DATA_POLICY, type DataPolicy } from "./data-policy.js";
import { fileTelemetrySink, type MemoryTelemetrySink } from "./telemetry.js";
import { DEFAULT_MEMORY_QUOTA_BYTES, MemoryError } from "./types.js";
import { memoryUnavailable, noAgentMemory } from "./index.js";

/** The memory fields of an agent record (`.rotifer/agents/<id>.json`). */
export interface AgentMemoryFields {
  id: string;
  /** Bytes; absent on agents created before v0.9.4 → the 10 MB default. */
  memoryQuota?: number;
  /** §30.2; absent on agents created before v0.9.4 → DEFAULT_DATA_POLICY. */
  dataPolicy?: DataPolicy;
}

export function memoryQuotaOf(agent: AgentMemoryFields): number {
  return agent.memoryQuota ?? DEFAULT_MEMORY_QUOTA_BYTES;
}

/**
 * The calling gene's content-derived id (the v0.9.1 v2 id).
 * There is no fallback: an entry's `createdBy` is what CREATOR_GENE_ONLY
 * compares, and a second id scheme would make the same gene two creators.
 */
export function geneIdentity(genesRoot: string, geneName: string): string {
  const result = geneIdV2(genesRoot, geneName);
  if ("reason" in result) {
    throw new MemoryError(
      "MEMORY_INVALID_INPUT",
      `gene '${geneName}' has no content-derived id, so it cannot use agent memory: ${result.reason}`,
    );
  }
  return result.id;
}

/**
 * rotifer-napi's memory, on a PlaygroundBinding opened on the project
 * (store: `<root>/.rotifer/playground.db`), or null when the loaded addon has
 * no memory functions. tryLoadBinding() opens its own instance under the
 * user's home for other purposes; memory belongs to the project, so this
 * opens another instance of the same class on the project root.
 */
export function projectNativeMemory(root: string): (NativeMemoryApi & NativeBinding) | null {
  const loaded = tryLoadBinding() as unknown as { constructor?: new (dir: string) => unknown } | null;
  if (!loaded || !hasNativeMemory(loaded) || typeof loaded.constructor !== "function") return null;
  const binding = new loaded.constructor(root);
  return hasNativeMemory(binding) ? (binding as NativeMemoryApi & NativeBinding) : null;
}

/**
 * What the WASM path needs for a gene's memory calls: a binding
 * opened on the project — the one tryLoadBinding() returns lives under the
 * user's home, and its store is not the agent's — and the memoryContext JSON
 * rotifer-napi takes.
 */
export interface WasmMemory {
  binding: NativeBinding;
  /** For executeGene: {"agentId","geneId"}; a gene without a v2 id gets {"agentId"} alone, and its calls are denied. */
  geneContext(geneName: string): string;
  /** For executeAlgebra: {"agentId"}; each gene runs as its entry's v2Id. */
  agentContext: string;
}

/**
 * Make sure the agent's memory exists in the native store, with its quota
 * (`agent create`, and first use by an agent created before v0.9.4).
 * Returns false when there is no native store to create it in.
 */
export function ensureAgentMemory(native: NativeMemoryApi | null, agent: AgentMemoryFields): boolean {
  if (!native) return false;
  try {
    native.memoryGet(agent.id);
  } catch (err) {
    const e = asMemoryError(err);
    if (e.code !== "MEMORY_NOT_FOUND") throw e;
    try {
      native.memoryCreate(agent.id, memoryQuotaOf(agent));
      // Entries with no retentionPolicy of their own inherit the agent's
      // DataPolicy retention; unlimited needs no call.
      const days = agent.dataPolicy?.retentionPolicy.maxRetentionDays ?? null;
      if (days !== null) native.memorySetDataPolicyRetention(agent.id, days);
    } catch (createErr) {
      throw asMemoryError(createErr);
    }
  }
  return true;
}

export interface OpenGeneMemoryOptions {
  /** Project root (where `.rotifer/` lives). */
  root: string;
  agent: AgentMemoryFields;
  gene: { id: string; domain: string };
  /** The store. Omitted → rotifer-napi's on this project, or none (memoryUnavailable). */
  backend?: MemoryBackend;
  telemetry?: MemoryTelemetrySink;
  audit?: MemoryAuditSink;
}

/** A GeneMemoryAccess for `gene` inside `agent`. */
export function openGeneMemory(options: OpenGeneMemoryOptions): GeneMemoryAccess {
  const { root, agent, gene } = options;
  let backend = options.backend;
  if (!backend) {
    const native = projectNativeMemory(root);
    if (!native) return memoryUnavailable();
    ensureAgentMemory(native, agent);
    backend = new NapiMemoryBackend(native);
  }
  return createGeneMemoryAccess({
    backend,
    caller: { agentId: agent.id, geneId: gene.id, domain: gene.domain },
    dataPolicy: agent.dataPolicy ?? DEFAULT_DATA_POLICY,
    telemetry: options.telemetry ?? fileTelemetrySink(root),
    audit: options.audit ?? fileAuditSink(root),
  });
}

export interface AgentMemoryHandle {
  /** "napi" (rotifer-core's store) or "unavailable" (no native memory: every call fails). */
  store: "napi" | "unavailable";
  /** The WASM path's binding and memoryContext; null without native memory, or when the store cannot execute genes. */
  wasm: WasmMemory | null;
  /** GeneMemoryAccess for one gene of the agent. Never undefined: a gene it cannot identify gets one that refuses, saying why. */
  forGene(geneName: string, phenotype: { domain?: unknown }): GeneMemoryAccess;
  /** The same, for a host that already holds the caller's v2 gene id and domain. */
  forCaller(geneId: string, domain: string): GeneMemoryAccess;
}

/**
 * An agent's memory for one `agent run` (spec §38.2; Node path ctx.memory),
 * in rotifer-napi's store on this project — created there on first use with
 * the agent's quota. Without native memory every call fails with
 * MEMORY_STORAGE_ERROR. Tests pass `native` to pin the store.
 */
export function openAgentMemory(options: {
  root: string;
  genesRoot: string;
  agent: AgentMemoryFields;
  native?: NativeMemoryApi | null;
  telemetry?: MemoryTelemetrySink;
  audit?: MemoryAuditSink;
}): AgentMemoryHandle {
  const { root, genesRoot, agent } = options;
  const native = options.native === undefined ? projectNativeMemory(root) : options.native;
  ensureAgentMemory(native, agent);
  const backend = native ? new NapiMemoryBackend(native) : null;
  const forCaller = (geneId: string, domain: string): GeneMemoryAccess =>
    backend
      ? openGeneMemory({ root, agent, gene: { id: geneId, domain }, backend, telemetry: options.telemetry, audit: options.audit })
      : memoryUnavailable();
  const canExecute = native !== null && typeof (native as Partial<NativeBinding>).executeGene === "function";
  return {
    store: backend ? "napi" : "unavailable",
    wasm: canExecute
      ? {
          binding: native as unknown as NativeBinding,
          geneContext(geneName) {
            const id = geneIdV2(genesRoot, geneName);
            return JSON.stringify("id" in id ? { agentId: agent.id, geneId: id.id } : { agentId: agent.id });
          },
          agentContext: JSON.stringify({ agentId: agent.id }),
        }
      : null,
    forGene(geneName, phenotype) {
      if (!backend) return memoryUnavailable();
      const domain = typeof phenotype.domain === "string" ? phenotype.domain : "";
      let geneId: string;
      try {
        geneId = geneIdentity(genesRoot, geneName);
      } catch (err) {
        // The store refuses a caller without a v2 id and records it (audit,
        // geneId null, and §17), as rotifer-core does
        // for WASM genes; the refusal tells the author why.
        return explainRefusals(forCaller("", domain), `gene '${geneName}' cannot use agent memory: ${(err as Error).message}`);
      }
      return forCaller(geneId, domain);
    },
    forCaller,
  };
}

/**
 * A throwaway agent memory for `rotifer test`, so a gene author can test a
 * gene that uses memory: rotifer-napi's store in a fresh directory under the
 * system temp dir, for a one-off agent with the default quota — as ctx.memory
 * for the Node path, and as a binding + memoryContext for the WASM path.
 * `dispose()` removes the directory. Without native memory every call is
 * MEMORY_STORAGE_ERROR, as anywhere else.
 */
export function scratchGeneMemory(options: {
  genesRoot: string;
  geneName: string;
  phenotype: { domain?: unknown };
  /** Tests pin the store; omitted → rotifer-napi's, if the addon has memory. */
  openNative?: (dir: string) => NativeMemoryApi | null;
}): { memory: GeneMemoryAccess; wasm: WasmMemory | null; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "rotifer-test-memory-"));
  const dispose = () => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a temp dir; the OS cleans what an open handle kept */
    }
  };
  try {
    const native = (options.openNative ?? projectNativeMemory)(dir);
    if (!native) {
      dispose();
      return { memory: memoryUnavailable(), wasm: null, dispose: () => {} };
    }
    const agent = { id: `test-${randomUUID()}` };
    const handle = openAgentMemory({ root: dir, genesRoot: options.genesRoot, agent, native });
    return { memory: handle.forGene(options.geneName, options.phenotype), wasm: handle.wasm, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

/** `memory`, whose MEMORY_ACCESS_DENIED refusals carry `why` instead of the store's generic message. */
function explainRefusals(memory: GeneMemoryAccess, why: string): GeneMemoryAccess {
  const explain = <T>(call: () => T): T => {
    try {
      return call();
    } catch (err) {
      if (err instanceof MemoryError && err.code === "MEMORY_ACCESS_DENIED") throw new MemoryError("MEMORY_ACCESS_DENIED", why);
      throw err;
    }
  };
  return {
    readMemory: (...args) => explain(() => memory.readMemory(...args)),
    writeMemory: (...args) => explain(() => memory.writeMemory(...args)),
    queryMemory: (...args) => explain(() => memory.queryMemory(...args)),
    deleteMemory: (...args) => explain(() => memory.deleteMemory(...args)),
  };
}

/**
 * `rotifer run`'s memory for the gene in `geneDir`: no agent, so every call
 * is refused "no agent context", and each refusal is reported to the
 * project's .rotifer/telemetry.jsonl (honouring ROTIFER_TELEMETRY / DO_NOT_TRACK)
 * with agentId null and the gene's v2 id when it has one — the record
 * rotifer-core makes for a WASM gene run the same way.
 */
export function projectNoAgentMemory(root: string, geneDir: string): GeneMemoryAccess {
  const id = geneIdV2(dirname(geneDir), basename(geneDir));
  return noAgentMemory({ telemetry: fileTelemetrySink(root), geneId: "id" in id ? id.id : null });
}
