// Compiled by tests/e2e/memory-subpath-export.test.ts with tsc (NodeNext):
// a gene author's import of the published subpath must type-check.
import { MemoryError, type GeneMemoryAccess, type MemoryEntry } from "@rotifer/playground/memory";

export function express(input: { key: string }, ctx: { memory: GeneMemoryAccess }): { value: string | null } {
  try {
    const entry: MemoryEntry | null = ctx.memory.readMemory(input.key, "PREFERENCE");
    return { value: entry ? new TextDecoder().decode(entry.value) : null };
  } catch (err) {
    if (err instanceof MemoryError && err.code === "MEMORY_ACCESS_DENIED") return { value: null };
    throw err;
  }
}
