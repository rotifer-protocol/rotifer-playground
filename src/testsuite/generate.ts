/**
 * Seeded input generation, shared by `arena submit` and the §47.5 T1 property
 * test.
 *
 * Moved verbatim out of arena-submit.ts rather than reimplemented: S_r has to
 * stay reproducible across releases, and a second generator that drifted from
 * this one would make `rotifer test` and Arena admission disagree about what a
 * Gene was fed. Same seed, same input, both callers.
 */

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateTestInput(schema: any, seed: number): Record<string, any> {
  if (!schema || !schema.properties) return { data: `test-input-${seed}` };

  const rng = mulberry32(seed * 2654435761);
  const input: Record<string, any> = {};
  for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
    if (prop.default !== undefined) {
      input[key] = prop.default;
    } else if (prop.enum && prop.enum.length > 0) {
      input[key] = prop.enum[seed % prop.enum.length];
    } else if (prop.type === "array" && prop.items) {
      const count = 50 + seed * 10;
      const arr: any[] = [];
      if (prop.items.type === "number") {
        let price = 100;
        for (let i = 0; i < count; i++) {
          price *= 1 + (rng() - 0.48) * 0.04;
          arr.push(Math.round(price * 100) / 100);
        }
      } else if (prop.items.type === "string") {
        for (let i = 0; i < Math.min(count, 5); i++) arr.push(`item-${i}`);
      } else if (prop.items.type === "object") {
        for (let i = 0; i < Math.min(count, 3); i++) {
          arr.push(generateTestInput({ properties: prop.items.properties }, seed + i));
        }
      }
      input[key] = arr;
    } else if (prop.type === "number") {
      const min = prop.minimum ?? 1;
      const max = prop.maximum ?? 100;
      input[key] = Math.min(min + seed, max);
    } else if (prop.type === "string") {
      input[key] = `test-${seed}`;
    } else if (prop.type === "boolean") {
      input[key] = seed % 2 === 0;
    }
  }
  return input;
}
