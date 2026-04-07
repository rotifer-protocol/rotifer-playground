const GENE_NAME_REGEX = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const MAX_GENE_NAME_LENGTH = 100;

/**
 * Validate a gene name for safe filesystem and API usage.
 * Rejects path traversal sequences, path separators, and non-conforming names.
 * @throws Error if the name is invalid
 */
export function validateGeneName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("Gene name must be a non-empty string");
  }
  if (name.length > MAX_GENE_NAME_LENGTH) {
    throw new Error(`Gene name exceeds ${MAX_GENE_NAME_LENGTH} characters: "${name}"`);
  }
  if (name.includes("..")) {
    throw new Error(`Gene name must not contain "..": "${name}"`);
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`Gene name must not contain path separators or null bytes: "${name}"`);
  }
  if (!GENE_NAME_REGEX.test(name)) {
    throw new Error(
      `Gene name "${name}" does not match required pattern: lowercase alphanumeric, dots, hyphens, underscores. Must start and end with alphanumeric.`,
    );
  }
}
