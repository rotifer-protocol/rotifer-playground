/**
 * memory-preference-demo — remembers a user's stated preferences across runs
 * in AgentMemory, category PREFERENCE (spec §38.1).
 *
 * PREFERENCE entries are what the agent learned about how its user wants
 * things; they are never evicted for quota (§38.1). They are written with
 * the default policy (SAME_DOMAIN, PRIVATE), so another gene of this domain
 * — including a newer version of this one after the genome changes — reads
 * them, and nothing outside the agent ever does.
 *
 * Keys start with "preference-demo/": every gene of an agent shares one key
 * space, so a gene prefixes its own keys.
 *
 * ctx.memory is always there on the Node path; run without an agent, every
 * call throws MemoryError(MEMORY_ACCESS_DENIED, "no agent context …"), and
 * this gene lets that error through rather than checking first.
 *
 * Input:  { user: string, set?: { language?: string, tone?: string } }
 * Output: { user, preferences: { language?, tone? }, updated: string[] }
 */

interface Memory {
  readMemory(key: string, category?: string): { value: Uint8Array } | null;
  writeMemory(key: string, value: Uint8Array, category: string): unknown;
}

const FIELDS = ["language", "tone"] as const;

export function express(
  input: { user?: string; set?: Record<string, unknown> },
  context: { memory: Memory },
) {
  const { memory } = context;
  const user = typeof input?.user === "string" && input.user.length > 0 ? input.user : null;
  if (!user) {
    return { __rotifer_error: { code: "INVALID_INPUT", message: "input.user must be a non-empty string" } };
  }

  const updated: string[] = [];
  for (const field of FIELDS) {
    const value = input.set?.[field];
    if (typeof value === "string" && value.length > 0) {
      memory.writeMemory(`preference-demo/${user}/${field}`, new TextEncoder().encode(value), "PREFERENCE");
      updated.push(field);
    }
  }

  const preferences: Record<string, string> = {};
  for (const field of FIELDS) {
    const entry = memory.readMemory(`preference-demo/${user}/${field}`, "PREFERENCE");
    if (entry) preferences[field] = new TextDecoder().decode(entry.value);
  }
  return { user, preferences, updated };
}
