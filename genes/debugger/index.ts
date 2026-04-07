function classifyError(log: string): string {
  const lower = log.toLowerCase();
  if (/typeerror|is not a function|cannot read propert|undefined is not|null is not/.test(lower)) return "TypeError";
  if (/referenceerror|is not defined|cannot find name/.test(lower)) return "ReferenceError";
  if (/syntaxerror|unexpected token|parsing error|invalid syntax/.test(lower)) return "SyntaxError";
  if (/networkerror|econnrefused|enotfound|fetch failed|timeout|econnreset|socket hang up/.test(lower)) return "NetworkError";
  if (/rangeerror|maximum call stack|out of range/.test(lower)) return "RuntimeError";
  if (/panic|fatal|segfault|sigsegv|stack overflow/.test(lower)) return "RuntimeError";
  if (/error|exception|failed|fault/.test(lower)) return "RuntimeError";
  return "Unknown";
}

function extractMessage(log: string): string {
  const patterns = [
    /(?:Error|Exception|Panic):\s*(.+)/i,
    /^(.+Error:.+)$/m,
    /thread '.+' panicked at '(.+)'/,
    /fatal error:\s*(.+)/i,
  ];
  for (const p of patterns) {
    const m = log.match(p);
    if (m) return m[1].trim();
  }
  const firstLine = log.split("\n")[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
}

interface StackLocation {
  file: string;
  line: number;
  column: number;
  functionName: string;
}

function parseStackTrace(trace: string): StackLocation[] {
  const locations: StackLocation[] = [];
  if (!trace) return locations;

  const lines = trace.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    let match: RegExpMatchArray | null;

    match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (match) {
      locations.push({ functionName: match[1], file: match[2], line: +match[3], column: +match[4] });
      continue;
    }
    match = line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (match) {
      locations.push({ functionName: "<anonymous>", file: match[1], line: +match[2], column: +match[3] });
      continue;
    }

    match = line.match(/File\s+"(.+?)",\s+line\s+(\d+),\s+in\s+(.+)/);
    if (match) {
      locations.push({ file: match[1], line: +match[2], column: 0, functionName: match[3] });
      continue;
    }

    match = line.match(/at\s+(.+?)(?:::(.+))?$/);
    if (match && !match[0].includes("(")) {
      const nextLine = lines[lines.indexOf(raw) + 1];
      if (nextLine) {
        const loc = nextLine.trim().match(/at\s+(.+?):(\d+):(\d+)/);
        if (loc) {
          locations.push({ functionName: match[0].replace(/^\d+:\s*/, ""), file: loc[1], line: +loc[2], column: +loc[3] });
          continue;
        }
      }
    }

    match = line.match(/^\d+:\s+(.+)/);
    if (match) {
      const nextLine = lines[lines.indexOf(raw) + 1];
      if (nextLine) {
        const loc = nextLine.trim().match(/at\s+(.+?):(\d+):(\d+)/);
        if (loc) {
          locations.push({ functionName: match[1], file: loc[1], line: +loc[2], column: +loc[3] });
          continue;
        }
      }
    }

    match = line.match(/(.+?)\(.*?\)\s*$/);
    if (match && !line.startsWith("at ")) {
      const nextLine = lines[lines.indexOf(raw) + 1];
      if (nextLine) {
        const loc = nextLine.trim().match(/(.+?):(\d+)/);
        if (loc) {
          locations.push({ functionName: match[1].trim(), file: loc[1], line: +loc[2], column: 0 });
          continue;
        }
      }
    }
  }
  return locations;
}

function analyzeRootCause(errorType: string, message: string, locations: StackLocation[]): string {
  const loc = locations.length > 0 ? ` in ${locations[0].file}:${locations[0].line}` : "";
  const causes: Record<string, string> = {
    TypeError: `A value was used in an unexpected way${loc}. A variable is likely null/undefined or the wrong type when a property access or function call was attempted.`,
    ReferenceError: `A variable or import is referenced before being defined or is misspelled${loc}. Check for typos in variable names or missing imports.`,
    SyntaxError: `The source code contains invalid syntax${loc}. Check for missing brackets, commas, semicolons, or mismatched quotes.`,
    NetworkError: `A network request failed${loc}. The target server may be unreachable, the URL may be incorrect, or there may be a DNS/firewall issue.`,
    RuntimeError: `A runtime error occurred${loc}. This may be caused by infinite recursion, out-of-bounds access, or an unhandled panic.`,
    Unknown: `An unclassified error occurred${loc}. Manual inspection of the error context is recommended.`,
  };
  return causes[errorType] || causes.Unknown;
}

function generateSuggestions(errorType: string, message: string): string[] {
  const base: Record<string, string[]> = {
    TypeError: [
      "Add null/undefined checks before accessing properties (optional chaining ?.)",
      "Verify the variable type with typeof or instanceof before use",
      "Check function signatures — ensure arguments match expected types",
    ],
    ReferenceError: [
      "Check for typos in variable or function names",
      "Ensure all imports are present and correctly spelled",
      "Verify the variable is declared in the correct scope",
    ],
    SyntaxError: [
      "Run a linter (ESLint, Ruff, clippy) to locate the exact syntax issue",
      "Check for unmatched brackets, parentheses, or quotes",
      "Verify JSON/config files are well-formed",
    ],
    NetworkError: [
      "Verify the target URL is correct and the server is running",
      "Check firewall rules and DNS resolution",
      "Add retry logic with exponential backoff for transient failures",
    ],
    RuntimeError: [
      "Check for infinite recursion or unbounded loops",
      "Add bounds checking for array/slice access",
      "Wrap risky operations in try/catch (or panic recovery in Go/Rust)",
    ],
    Unknown: [
      "Search the error message in documentation or issue trackers",
      "Add more granular logging around the failure point",
      "Isolate the failing code path with a minimal reproduction",
    ],
  };
  return base[errorType] || base.Unknown;
}

export function express(input: { errorLog: string; stackTrace?: string; language?: string }) {
  const errorType = classifyError(input.errorLog);
  const errorMessage = extractMessage(input.errorLog);
  const locations = parseStackTrace(input.stackTrace || "");
  const rootCause = analyzeRootCause(errorType, errorMessage, locations);
  const suggestions = generateSuggestions(errorType, errorMessage);

  return { errorType, errorMessage, locations, rootCause, suggestions };
}
