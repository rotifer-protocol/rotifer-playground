/**
 * Recursively converts all object keys from snake_case to camelCase.
 * Handles nested objects and arrays.
 */
export function toCamelCase(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[camelKey] = toCamelCase(value);
    }
    return out;
  }
  return obj;
}
