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
const LANGUAGES = ["typescript", "javascript", "json", "markdown", "rust"] as const;

export function express(input: CodeFormatInput): CodeFormatOutput {
  // `input.code` went straight into .replace(), so anything that was not a
  // string threw — all three illegal shapes crashed this Gene rather than
  // producing an answer. The schema declares the type, so a value of another
  // type is treated as a missing one.
  const rawCode: unknown = input.code;
  const code = typeof rawCode === "string" ? rawCode : "";

  // `language` was echoed into the output unchecked, so a value outside the
  // declared enum came back out as if the Gene had recognised it. It did not:
  // an unrecognised language falls through to the generic whitespace pass, and
  // the output should say so rather than repeat what it was handed.
  const rawLanguage: unknown = input.language;
  const language = (LANGUAGES as readonly unknown[]).includes(rawLanguage)
    ? (rawLanguage as string)
    : "unknown";

  let formatted: string;

  switch (language) {
    case "json":
      try {
        formatted = JSON.stringify(JSON.parse(code), null, 2);
      } catch {
        formatted = code;
      }
      break;
    default:
      formatted = code
        .replace(/\t/g, "  ")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
      break;
  }

  return {
    formatted,
    changed: formatted !== code,
    language,
  };
}
