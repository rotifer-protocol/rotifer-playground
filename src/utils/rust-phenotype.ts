/**
 * Converts a phenotype.json, as the CLI writes it, into the JSON shape that
 * `rotifer_core::types::gene::Phenotype` deserializes:
 *
 * | field          | phenotype.json                     | Rust                 |
 * |----------------|------------------------------------|----------------------|
 * | `irHash`       | 64-char hex string                 | `Option<[u8; 32]>`   |
 * | `createdAt`    | epoch ms, or ISO 8601 (`wrap`)     | `u64` epoch ms       |
 * | `dependencies` | gene names, or 64-char hex ids     | `Vec<[u8; 32]>`      |
 *
 * Values are converted, not dropped. A value that cannot be converted
 * faithfully (an irHash that is not 32 bytes of hex, a createdAt that is not a
 * date, a dependency named without a way to resolve the name) is omitted, so
 * Rust falls back to its serde default (`None` / `0` / empty). None of the
 * three fields is read while executing a gene — they are metadata — so
 * omitting one does not change what runs. A caller that must not lose a value
 * silently checks `createdAtProblem` first.
 *
 * Every path that hands a phenotype.json to rotifer-core goes through this:
 * `agent run`'s algebra executor, `compile`'s IR compiler (#448), the L0 gate
 * and `test --compliance` (#449).
 *
 * Other fields pass through unchanged.
 */

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

function toEpochMillis(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }
  return undefined;
}

/**
 * Why `createdAt` cannot be converted, or undefined when it can (or is absent).
 * For callers that report the field rather than let Rust default it to 0.
 */
export function createdAtProblem(phenotype: Record<string, unknown>): string | undefined {
  const { createdAt } = phenotype;
  if (createdAt === undefined) return undefined;
  if (toEpochMillis(createdAt) !== undefined) return undefined;
  return `createdAt ${JSON.stringify(createdAt)} is not a date: use epoch milliseconds or an ISO 8601 timestamp`;
}

/**
 * @param geneId maps a dependency given by gene name to its gene id, using the
 *   same derivation as the gene entries passed alongside the phenotype. Without
 *   it, only dependencies already given as 64-char hex ids are kept.
 */
export function toRustPhenotype(
  phenotype: Record<string, unknown>,
  geneId?: (geneName: string) => string,
): Record<string, unknown> {
  const { irHash, createdAt, dependencies, ...rest } = phenotype;
  const out: Record<string, unknown> = { ...rest };

  if (typeof irHash === "string" && HEX_32_BYTES.test(irHash)) {
    out.irHash = hexToBytes(irHash);
  }

  const ms = toEpochMillis(createdAt);
  if (ms !== undefined) out.createdAt = ms;

  if (Array.isArray(dependencies)) {
    out.dependencies = dependencies
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .filter((d) => HEX_32_BYTES.test(d) || geneId !== undefined)
      .map((d) => hexToBytes(HEX_32_BYTES.test(d) ? d : geneId!(d)));
  }

  return out;
}
