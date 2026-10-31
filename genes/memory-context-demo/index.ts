/**
 * memory-context-demo — keeps notes per topic that later runs build on, in
 * AgentMemory, category CONTEXT (spec §38.1).
 *
 * CONTEXT entries are domain knowledge the agent accumulated while working.
 * Under quota pressure they are the last to go before PREFERENCE (which never
 * does), oldest first. Topics are listed back with queryMemory by category
 * and key prefix (`context-demo/topic/`). ctx.memory is always there on the
 * Node path; without an agent its calls throw MEMORY_ACCESS_DENIED, which
 * this gene lets through.
 *
 * Input:  { topic: string, note?: string }
 * Output: { topic, notes: string[], topics: string[] }
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

const PREFIX = "context-demo/topic/";
const MAX_NOTES = 20;

export function express(input: { topic?: string; note?: string }, context: { memory: Memory }) {
  const { memory } = context;
  const topic = typeof input?.topic === "string" ? input.topic.trim() : "";
  if (!topic) {
    return { __rotifer_error: { code: "INVALID_INPUT", message: "input.topic must be a non-empty string" } };
  }

  const key = PREFIX + topic;
  const existing = memory.readMemory(key, "CONTEXT");
  let notes: string[] = existing ? JSON.parse(new TextDecoder().decode(existing.value)) : [];
  if (typeof input.note === "string" && input.note.trim().length > 0) {
    notes = [...notes, input.note.trim()].slice(-MAX_NOTES);
    memory.writeMemory(key, new TextEncoder().encode(JSON.stringify(notes)), "CONTEXT");
  }

  const topics = memory
    .queryMemory({ category: "CONTEXT", keyPrefix: PREFIX })
    .map((e) => e.key.slice(PREFIX.length))
    .sort();
  return { topic, notes, topics };
}
