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
export function express(input: FileReadInput): FileReadOutput {
  // The schema declares encoding as an enum, so a value outside it is not a
  // third choice — fall back to the documented default rather than passing it
  // to Buffer.toString(), which would throw on an unknown encoding.
  const rawEncoding: unknown = input.encoding;
  const encoding = rawEncoding === "base64" ? "base64" : "utf-8";

  // readFileSync accepts a number as a *file descriptor*, so `{"path": 42}`
  // did not fail as a bad path — it attempted to read whatever fd 42 happened
  // to be, and reported EBADF only because that one was closed. A caller
  // choosing the number gets to choose the descriptor, which is not a path
  // read at all. The type check has to happen before the call, not inside the
  // catch: by then the read has already been attempted.
  const rawPath: unknown = input.path;
  if (typeof rawPath !== "string" || rawPath === "") {
    return {
      content: "[error] INVALID_PATH: path must be a non-empty string",
      size: 0,
      encoding,
    };
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(rawPath);
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
