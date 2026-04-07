interface ParseInput {
  source: string;
  filename?: string;
}

interface ContractInfo {
  name: string;
  type: string;
  inherits: string[];
}

interface FunctionInfo {
  name: string;
  params: string;
  visibility: string;
  modifiers: string[];
  mutability: string;
}

interface StateVariable {
  name: string;
  type: string;
  visibility: string;
}

interface EventInfo {
  name: string;
  params: string;
}

interface ParseOutput {
  source: string;
  contracts: ContractInfo[];
  functions: FunctionInfo[];
  stateVariables: StateVariable[];
  events: EventInfo[];
  imports: string[];
}

const KNOWN_MODIFIERS = [
  "onlyOwner", "nonReentrant", "whenNotPaused", "whenPaused",
  "onlyRole", "onlyAdmin", "onlyMinter", "initializer",
  "override", "virtual",
];

const VISIBILITY_KEYWORDS = new Set(["public", "private", "internal", "external"]);
const MUTABILITY_KEYWORDS = new Set(["pure", "view", "payable"]);

function stripComments(source: string): string {
  return source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractContracts(source: string): ContractInfo[] {
  const results: ContractInfo[] = [];
  const re = /\b(contract|interface|library|abstract\s+contract)\s+(\w+)(?:\s+is\s+([^{]+))?/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const rawType = match[1].trim();
    const type = rawType === "abstract contract" ? "abstract" : rawType;
    const inherits = match[3]
      ? match[3].split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    results.push({ name: match[2], type, inherits });
  }

  return results;
}

function extractFunctions(source: string): FunctionInfo[] {
  const results: FunctionInfo[] = [];
  const re = /\bfunction\s+(\w+)\s*\(([^)]*)\)([^{;]*)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const params = match[2].trim();
    const rest = match[3].trim();

    const tokens = rest.split(/\s+/);
    let visibility = "internal";
    let mutability = "nonpayable";
    const modifiers: string[] = [];

    for (const token of tokens) {
      const clean = token.replace(/[^a-zA-Z]/g, "");
      if (!clean) continue;
      if (VISIBILITY_KEYWORDS.has(clean)) {
        visibility = clean;
      } else if (MUTABILITY_KEYWORDS.has(clean)) {
        mutability = clean;
      } else if (KNOWN_MODIFIERS.includes(clean)) {
        modifiers.push(clean);
      } else if (clean === "returns") {
        break;
      }
    }

    results.push({ name, params, visibility, modifiers, mutability });
  }

  return results;
}

function extractStateVariables(source: string): StateVariable[] {
  const results: StateVariable[] = [];
  const re = /\b(uint\d*|int\d*|bool|address|string|bytes\d*|mapping\s*\([^)]*\))\s+(public|private|internal|external)?\s*(?:constant|immutable)?\s*(\w+)\s*[;=]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    results.push({
      type: match[1].trim(),
      visibility: match[2] || "internal",
      name: match[3],
    });
  }

  return results;
}

function extractEvents(source: string): EventInfo[] {
  const results: EventInfo[] = [];
  const re = /\bevent\s+(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    results.push({ name: match[1], params: match[2].trim() });
  }

  return results;
}

function extractImports(source: string): string[] {
  const results: string[] = [];
  const re = /\bimport\s+.*?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    results.push(match[1]);
  }

  return results;
}

export function express(input: ParseInput): ParseOutput {
  if (!input?.source || typeof input.source !== "string") {
    return {
      source: "",
      contracts: [],
      functions: [],
      stateVariables: [],
      events: [],
      imports: [],
    };
  }

  const cleaned = stripComments(input.source);

  return {
    source: input.source,
    contracts: extractContracts(cleaned),
    functions: extractFunctions(cleaned),
    stateVariables: extractStateVariables(cleaned),
    events: extractEvents(cleaned),
    imports: extractImports(cleaned),
  };
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function visibilityBadge(visibility: string): string {
  const v = visibility.toLowerCase();
  if (v === "private") return "🔒 private";
  if (v === "internal") return "🟡 internal";
  if (v === "public") return "🟢 public";
  if (v === "external") return "🔵 external";
  return `${DIM}${visibility}${RESET}`;
}

export function display(output: ParseOutput, options?: { verbose?: boolean }): void {
  console.log(`${BOLD}${CYAN}Solidity parse${RESET}`);
  console.log(`${DIM}${"─".repeat(44)}${RESET}`);
  console.log(`${BOLD}Contracts${RESET} ${DIM}(${output.contracts.length})${RESET}`);
  for (const c of output.contracts) {
    const inherits =
      c.inherits.length > 0 ? ` ${DIM}is${RESET} ${YELLOW}${c.inherits.join(", ")}${RESET}` : "";
    console.log(`  ${GREEN}${c.name}${RESET} ${BLUE}${c.type}${RESET}${inherits}`);
  }

  console.log("");
  console.log(`${BOLD}Functions${RESET} ${DIM}(${output.functions.length})${RESET}`);
  for (const fn of output.functions) {
    const vis = visibilityBadge(fn.visibility);
    const modStr =
      options?.verbose && fn.modifiers.length > 0
        ? ` ${DIM}[${fn.modifiers.join(", ")}]${RESET}`
        : "";
    console.log(
      `  ${BOLD}${fn.name}${RESET}${modStr} ${vis} ${DIM}${fn.mutability}${RESET}`
    );
    if (options?.verbose) {
      console.log(`    ${DIM}params:${RESET} ${fn.params || "(none)"}`);
    }
  }

  console.log("");
  console.log(`${BOLD}State variables${RESET} ${DIM}(${output.stateVariables.length})${RESET}`);
  for (const sv of output.stateVariables) {
    console.log(
      `  ${GREEN}${sv.name}${RESET} ${BLUE}${sv.type}${RESET} ${visibilityBadge(sv.visibility)}`
    );
  }

  console.log("");
  console.log(`${BOLD}Events${RESET} ${DIM}(${output.events.length})${RESET}`);
  for (const ev of output.events) {
    if (options?.verbose) {
      console.log(`  ${YELLOW}${ev.name}${RESET} ${DIM}(${ev.params || "no params"})${RESET}`);
    } else {
      console.log(`  ${YELLOW}${ev.name}${RESET}`);
    }
  }

  if (output.imports.length > 0) {
    console.log("");
    console.log(`${BOLD}Imports${RESET} ${DIM}(${output.imports.length})${RESET}`);
    for (const imp of output.imports) {
      console.log(`  ${DIM}${imp}${RESET}`);
    }
  }
}
