import { readFileSync } from "node:fs";

interface FileReadInput {
  path: string;
  encoding?: "utf-8" | "base64";
}

interface FileReadOutput {
  content: string;
  size: number;
  encoding: string;
}

/**
 * Genesis Gene: File Read
 *
 * Reads a local file and returns its contents.
 * Restricted by L0 sandbox constraints (path allowlist).
 */
export async function express(input: FileReadInput): Promise<FileReadOutput> {
  const encoding = input.encoding ?? "utf-8";

  let buffer: Buffer;
  try {
    buffer = readFileSync(input.path);
  } catch (err: any) {
    return {
      content: `[error] ${err.code ?? "UNKNOWN"}: ${err.message}`,
      size: 0,
      encoding,
    };
  }

  const content = encoding === "base64"
    ? buffer.toString("base64")
    : buffer.toString("utf-8");

  return {
    content,
    size: buffer.length,
    encoding,
  };
}
