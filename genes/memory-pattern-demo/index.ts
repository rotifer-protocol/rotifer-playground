/**
 * memory-pattern-demo — learns which queries an agent sees most often, in
 * AgentMemory, category PATTERN (spec §38.1).
 *
 * PATTERN entries are what the agent noticed from repeated work. Under quota
 * pressure they go after CACHE and before CONTEXT, oldest first (§38.1).
 * One entry per query (`pattern-demo/query/<query>`), so the counts are read
 * back with queryMemory by key prefix. ctx.memory is always there on the
 * Node path; without an agent its calls throw MEMORY_ACCESS_DENIED, which
 * this gene lets through.
 *
 * Input:  { query: string }
 * Output: { query, count, top: [{ query, count }] }   top 3, most frequent first
 */

interface Entry {
  key: string;
  value: Uint8Array;
}
interface Memory {
  readMemory(key: string, category?: string): Entry | null;
  writeMemory(key: string, value: Uint8Array, category: string): unknown;
  queryMemory(filter: { category?: string; keyPrefix?: string }): Entry[];
}

const PREFIX = "pattern-demo/query/";

export function express(input: { query?: string }, context: { memory: Memory }) {
  const { memory } = context;
  const query = typeof input?.query === "string" ? input.query.trim().toLowerCase() : "";
  if (!query) {
    return { __rotifer_error: { code: "INVALID_INPUT", message: "input.query must be a non-empty string" } };
  }

  const key = PREFIX + query;
  const seen = memory.readMemory(key, "PATTERN");
  const count = (seen ? Number(new TextDecoder().decode(seen.value)) || 0 : 0) + 1;
  memory.writeMemory(key, new TextEncoder().encode(String(count)), "PATTERN");

  const all = memory.queryMemory({ category: "PATTERN", keyPrefix: PREFIX });
  const top = all
    .map((e) => ({ query: e.key.slice(PREFIX.length), count: Number(new TextDecoder().decode(e.value)) || 0 }))
    .sort((a, b) => b.count - a.count || (a.query < b.query ? -1 : 1))
    .slice(0, 3);
  return { query, count, top };
}
