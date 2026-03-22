interface CodeFormatInput {
  code: string;
  language: "typescript" | "javascript" | "json" | "markdown" | "rust";
}

interface CodeFormatOutput {
  formatted: string;
  changed: boolean;
  language: string;
}

/**
 * Genesis Gene: Code Format
 *
 * Formats source code. MVP uses simple heuristic formatting.
 * Production binding would delegate to prettier/rustfmt/etc.
 */
export async function express(input: CodeFormatInput): Promise<CodeFormatOutput> {
  let formatted: string;

  switch (input.language) {
    case "json":
      try {
        formatted = JSON.stringify(JSON.parse(input.code), null, 2);
      } catch {
        formatted = input.code;
      }
      break;
    default:
      formatted = input.code
        .replace(/\t/g, "  ")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
      break;
  }

  return {
    formatted,
    changed: formatted !== input.code,
    language: input.language,
  };
}
