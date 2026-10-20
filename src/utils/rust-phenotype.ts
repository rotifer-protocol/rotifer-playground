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
 * date) is omitted, so Rust falls back to its serde default (`None` / `0`).
 * None of the three fields is read while executing a gene — they are
 * metadata — so omitting one does not change what runs.
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
 * @param geneId maps a dependency given by gene name to its gene id, using the
 *   same derivation as the gene entries passed alongside the phenotype.
 */
export function toRustPhenotype(
  phenotype: Record<string, unknown>,
  geneId: (geneName: string) => string,
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
      .map((d) => hexToBytes(HEX_32_BYTES.test(d) ? d : geneId(d)));
  }

  return out;
}
