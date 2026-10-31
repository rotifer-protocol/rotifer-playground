/**
 * MemoryStore over Supabase. The client is built per request with the
 * caller's own Authorization header and the anon key, so every query runs
 * as that account under the RLS of migration 20261030220000 — this function
 * holds no service_role key and cannot read anyone else's memory.
 */

import {
  type ContainerRow,
  DbError,
  type EvictedEntry,
  type ExpiredEntry,
  type MemoryStore,
  type WriteParams,
} from "./handler.ts";
import { type CallerGene, type EntryRow, type MemoryErrorCode, MemoryError, type MemoryFilter } from "./wire.ts";

// The supabase-js client, typed loosely so this module and its tests do not
// load the SDK (CI runs the tests with no network install); index.ts passes
// the real client.
// deno-lint-ignore no-explicit-any
type Db = any;

/**
 * An RPC's expected refusal after its purge: {error: {code, message},
 * expired}. The purge was committed; the refusal is thrown
 * here with the purged ids attached.
 */
interface Refusal {
  error?: { code: MemoryErrorCode; message: string };
  expired?: ExpiredEntry[];
}

function refused(out: Refusal): void {
  if (out && out.error) throw new MemoryError(out.error.code, out.error.message, out.expired ?? []);
}

interface PgError {
  code?: string;
  message?: string;
}

function fail(e: PgError): never {
  throw new DbError(e.code, e.message ?? "database error");
}

export function supabaseStore(db: Db): MemoryStore {
  return {
    async registerContainer(agentId, quota) {
      if (quota === undefined) {
        const { error } = await db.from("agent_memory_containers")
          .upsert({ agent_id: agentId }, { onConflict: "owner_id,agent_id", ignoreDuplicates: true });
        if (error) fail(error);
        return;
      }
      // Update first; insert only when the account has no container yet. A
      // concurrent insert of the same agent loses the race with 23505 and
      // retries the update once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const upd = await db.from("agent_memory_containers")
          .update({ quota_bytes: quota }).eq("agent_id", agentId).select("agent_id");
        if (upd.error) fail(upd.error);
        if (upd.data && upd.data.length > 0) return;
        const ins = await db.from("agent_memory_containers").insert({ agent_id: agentId, quota_bytes: quota });
        if (!ins.error) return;
        if (ins.error.code !== "23505") fail(ins.error);
      }
      throw new DbError(undefined, "could not register the agent's memory");
    },

    async getContainer(agentId) {
      const { data, error } = await db.rpc("agent_memory_container", { p_agent_id: agentId });
      if (error) fail(error);
      const rows = (data ?? []) as ContainerRow[];
      return rows[0] ?? null;
    },

    async readEntry(agentId, key, category, caller) {
      const { data, error } = await db.rpc("agent_memory_read", {
        p_agent_id: agentId,
        p_key: key,
        p_category: category ?? null,
        p_caller_gene_id: caller.geneId,
        p_caller_domain: caller.domain,
      });
      if (error) fail(error);
      refused(data);
      const out = data as { entry: EntryRow | null; expired: ExpiredEntry[] };
      return { entry: out.entry ?? null, expired: out.expired ?? [] };
    },

    async listEntries(agentId: string, filter: MemoryFilter, caller: CallerGene, limit: number) {
      const { data, error } = await db.rpc("agent_memory_query", {
        p_agent_id: agentId,
        p_caller_gene_id: caller.geneId,
        p_caller_domain: caller.domain,
        p_category: filter.category ?? null,
        p_key_prefix: filter.keyPrefix ?? null,
        p_since: filter.since ?? null,
        p_until: filter.until ?? null,
        p_limit: limit,
      });
      if (error) fail(error);
      const out = data as { entries: EntryRow[]; expired: ExpiredEntry[] };
      return { entries: out.entries ?? [], expired: out.expired ?? [] };
    },

    async write(p: WriteParams) {
      const { data, error } = await db.rpc("agent_memory_write", {
        p_agent_id: p.agentId,
        p_key: p.key,
        p_value: p.value,
        p_category: p.category,
        p_caller_gene_id: p.callerGeneId,
        p_caller_domain: p.callerDomain,
        p_read_scope: p.readScope,
        p_write_scope: p.writeScope,
        p_share_policy: p.sharePolicy,
        p_retention_policy: p.retentionPolicy,
        p_set_retention: p.setRetention,
      });
      if (error) fail(error);
      refused(data);
      const out = data as { entry: EntryRow; evicted: EvictedEntry[]; expired: ExpiredEntry[] };
      return { entry: out.entry, evicted: out.evicted ?? [], expired: out.expired ?? [] };
    },

    async deleteEntry(agentId, key, caller) {
      const { data, error } = await db.rpc("agent_memory_delete", {
        p_agent_id: agentId,
        p_key: key,
        p_caller_gene_id: caller.geneId,
        p_caller_domain: caller.domain,
      });
      if (error) fail(error);
      refused(data);
      const out = data as { entryId: string; key: string; expired: ExpiredEntry[] };
      return { entryId: out.entryId, key: out.key, expired: out.expired ?? [] };
    },
  };
}
