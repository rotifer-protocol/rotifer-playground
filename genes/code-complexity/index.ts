interface ComplexityInput {
  code: string;
  language: string;
  threshold?: number;
}

interface ComplexityOutput {
  cyclomaticComplexity: number;
  linesOfCode: number;
  maxNestingDepth: number;
  functionCount: number;
  rating: "low" | "moderate" | "high" | "very-high";
  suggestions: string[];
}

const BRANCH_PATTERNS: Record<string, RegExp[]> = {
  typescript: [/\bif\b/g, /\belse\s+if\b/g, /\bwhile\b/g, /\bfor\b/g, /\bcase\b/g, /\bcatch\b/g, /\b\?\?/g, /\?\./g, /&&/g, /\|\|/g, /\?[^?:]/g],
  javascript: [/\bif\b/g, /\belse\s+if\b/g, /\bwhile\b/g, /\bfor\b/g, /\bcase\b/g, /\bcatch\b/g, /\b\?\?/g, /\?\./g, /&&/g, /\|\|/g, /\?[^?:]/g],
  python: [/\bif\b/g, /\belif\b/g, /\bwhile\b/g, /\bfor\b/g, /\bexcept\b/g, /\band\b/g, /\bor\b/g],
  rust: [/\bif\b/g, /\belse\s+if\b/g, /\bwhile\b/g, /\bfor\b/g, /\bmatch\b/g, /=>/g, /&&/g, /\|\|/g],
  go: [/\bif\b/g, /\belse\s+if\b/g, /\bfor\b/g, /\bcase\b/g, /&&/g, /\|\|/g],
};

const FUNC_PATTERNS: Record<string, RegExp> = {
  typescript: /\b(?:function\b|=>|(?:async\s+)?(?:get|set)\s+\w+\s*\()/g,
  javascript: /\b(?:function\b|=>)/g,
  python: /\bdef\s+/g,
  rust: /\bfn\s+/g,
  go: /\bfunc\s+/g,
};

function stripComments(code: string, lang: string): string {
  if (lang === "python") {
    return code.replace(/#.*/g, "").replace(/"""[\s\S]*?"""/g, "").replace(/'''[\s\S]*?'''/g, "");
  }
  return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function countNesting(code: string, lang: string): number {
  if (lang === "python") {
    let max = 0;
    for (const line of code.split("\n")) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      const level = Math.floor(indent / 4);
      if (level > max) max = level;
    }
    return max;
  }
  let max = 0, cur = 0;
  for (const ch of code) {
    if (ch === "{") { cur++; if (cur > max) max = cur; }
    else if (ch === "}") { cur = Math.max(0, cur - 1); }
  }
  return max;
}

export async function express(input: ComplexityInput): Promise<ComplexityOutput> {
  const code = input.code || "";
  const lang = (input.language || "javascript").toLowerCase();
  const threshold = input.threshold ?? 10;

  const stripped = stripComments(code, lang);
  const lines = stripped.split("\n").filter((l) => l.trim().length > 0);
  const linesOfCode = lines.length;

  const patterns = BRANCH_PATTERNS[lang] || BRANCH_PATTERNS.javascript;
  let branches = 0;
  for (const pat of patterns) {
    const re = new RegExp(pat.source, pat.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) branches++;
  }
  const cyclomaticComplexity = branches + 1;

  const funcPat = FUNC_PATTERNS[lang] || FUNC_PATTERNS.javascript;
  const funcRe = new RegExp(funcPat.source, funcPat.flags);
  let functionCount = 0;
  while (funcRe.exec(stripped) !== null) functionCount++;
  if (functionCount === 0) functionCount = 1;

  const maxNestingDepth = countNesting(stripped, lang);

  let rating: ComplexityOutput["rating"];
  if (cyclomaticComplexity <= 5) rating = "low";
  else if (cyclomaticComplexity <= 10) rating = "moderate";
  else if (cyclomaticComplexity <= 20) rating = "high";
  else rating = "very-high";

  const suggestions: string[] = [];
  if (cyclomaticComplexity > threshold) {
    suggestions.push(`Cyclomatic complexity (${cyclomaticComplexity}) exceeds threshold (${threshold}). Consider splitting into smaller functions.`);
  }
  if (maxNestingDepth > 4) {
    suggestions.push(`Max nesting depth is ${maxNestingDepth}. Consider early returns or extracting nested logic.`);
  }
  if (linesOfCode > 200) {
    suggestions.push(`File has ${linesOfCode} lines. Consider splitting into multiple modules.`);
  }

  return { cyclomaticComplexity, linesOfCode, maxNestingDepth, functionCount, rating, suggestions };
}
