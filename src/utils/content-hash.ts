import { createHash } from "node:crypto";

function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function canonicalSerialize(
  phenotype: Record<string, unknown>,
): string {
  return JSON.stringify(sortKeysDeep(phenotype));
}

export function contentHash(phenotype: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalSerialize(phenotype))
    .digest("hex");
}
