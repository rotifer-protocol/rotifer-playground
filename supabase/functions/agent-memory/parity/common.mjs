// Shared by run-napi.mjs (Node) and run-cloud.ts (Deno): turn scenario
// steps into requests, and results into a form both bindings must agree on.

/**
 * A step's request with value specs ({fill, length}) turned into base64 and
 * "$name" references resolved from the scenario's top level.
 */
export function materialize(request, scenario = {}) {
  const out = { ...request };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.startsWith("$")) out[k] = scenario[v.slice(1)];
  }
  if (out.value && typeof out.value === "object") {
    const bytes = new Uint8Array(out.value.length).fill(out.value.fill);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out.value = btoa(s);
  }
  return out;
}

/**
 * What must match across bindings. Removed: createdAt/updatedAt (clocks
 * differ) and nothing else — entryId, createdBy, lastAccessedBy, value,
 * category and both policies are compared as returned.
 */
export function normalizeEntry(e) {
  if (e === null || e === undefined) return e ?? null;
  const { createdAt: _c, updatedAt: _u, ...rest } = e;
  return rest;
}

export function normalize(op, value) {
  switch (op) {
    case "create":
      return { agentId: value.agentId, quota: value.quota, totalSize: value.totalSize };
    case "write":
    case "read":
      return normalizeEntry(value);
    case "query":
      return value.map(normalizeEntry);
    case "delete":
      return null;
    case "usage":
      return { quota: value.quota, totalSize: value.totalSize };
    default:
      throw new Error(`unknown op ${op}`);
  }
}

/** The contract code at the start of an error message, or the message itself. */
export function errorCode(message) {
  const m = /^(MEMORY_[A-Z_]+)\b/.exec(String(message));
  return m ? m[1] : `UNCODED: ${String(message).slice(0, 160)}`;
}

/** Expired entry ids in a fixed order, so the two sides compare as sets. */
export function normalizeExpired(ids) {
  return [...ids].sort();
}

/** The scenario file: first argument, default scenario.json. */
export function scenarioName(arg) {
  return arg ?? "scenario.json";
}

export const STEP_PAUSE_MS = 15;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
