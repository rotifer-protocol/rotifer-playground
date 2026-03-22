interface GrammarInput {
  text: string;
  strict?: boolean;
}

interface GrammarIssue {
  rule: string;
  message: string;
  position: number;
  suggestion: string;
}

interface GrammarOutput {
  issues: GrammarIssue[];
  score: number;
  summary: string;
}

interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
  suggestion: (match: RegExpExecArray) => string;
  strict?: boolean;
}

const RULES: Rule[] = [
  {
    id: "double-space",
    pattern: /  +/g,
    message: "Multiple consecutive spaces",
    suggestion: () => "Use a single space",
  },
  {
    id: "sentence-capitalization",
    pattern: /(?:^|[.!?]\s+)([a-z])/gm,
    message: "Sentence should start with a capital letter",
    suggestion: (m) => `Capitalize "${m[1]}" → "${m[1].toUpperCase()}"`,
  },
  {
    id: "repeated-word",
    pattern: /\b(\w{2,})\s+\1\b/gi,
    message: "Repeated word",
    suggestion: (m) => `Remove duplicate "${m[1]}"`,
  },
  {
    id: "missing-period",
    pattern: /[a-zA-Z]\s*$/,
    message: "Text does not end with punctuation",
    suggestion: () => "Add a period at the end",
  },
  {
    id: "space-before-punctuation",
    pattern: /\s+[,;:!?.]/g,
    message: "Space before punctuation",
    suggestion: () => "Remove space before punctuation mark",
  },
  {
    id: "no-space-after-punctuation",
    pattern: /[,;:][^\s\n"')\]]/g,
    message: "Missing space after punctuation",
    suggestion: () => "Add a space after the punctuation mark",
  },
  {
    id: "a-an-mismatch",
    pattern: /\ba\s+(?=[aeiouAEIOU]\w)/g,
    message: '"a" before a vowel sound — should be "an"',
    suggestion: () => 'Use "an" before vowel sounds',
  },
  {
    id: "an-consonant-mismatch",
    pattern: /\ban\s+(?=[bcdfgjklmnpqrstvwxyzBCDFGJKLMNPQRSTVWXYZ]\w)/g,
    message: '"an" before a consonant sound — should be "a"',
    suggestion: () => 'Use "a" before consonant sounds',
  },
  {
    id: "its-confusion",
    pattern: /\bits\s+(?=a\b|the\b|not\b|been\b|going\b|time\b)/gi,
    message: 'Possible "it\'s" (it is) instead of "its" (possessive)',
    suggestion: () => 'Consider "it\'s" if you mean "it is"',
  },
  {
    id: "then-than",
    pattern: /\bmore\s+\w+\s+then\b/gi,
    message: '"then" should be "than" in comparisons',
    suggestion: () => 'Use "than" for comparisons',
  },
  {
    id: "double-negative",
    pattern: /\b(?:don't|doesn't|didn't|won't|wouldn't|can't|couldn't)\s+\w*\s*(?:no|nothing|nobody|nowhere|never)\b/gi,
    message: "Double negative detected",
    suggestion: () => "Rewrite to use a single negative",
  },
  {
    id: "oxford-comma",
    pattern: /,\s+\w+\s+and\s+/gi,
    message: "Consider Oxford comma before 'and' in a list",
    suggestion: () => "Add comma before 'and' in lists of three or more",
    strict: true,
  },
  {
    id: "passive-voice",
    pattern: /\b(?:is|are|was|were|been|being)\s+\w+ed\b/gi,
    message: "Passive voice detected",
    suggestion: () => "Consider rewriting in active voice",
    strict: true,
  },
  {
    id: "very-qualifier",
    pattern: /\bvery\s+\w+/gi,
    message: 'Weak qualifier "very" — consider a stronger word',
    suggestion: () => 'Replace "very + adjective" with a single stronger adjective',
    strict: true,
  },
  {
    id: "trailing-whitespace",
    pattern: /[ \t]+$/gm,
    message: "Trailing whitespace at end of line",
    suggestion: () => "Remove trailing whitespace",
  },
];

/**
 * Grammar Checker Gene
 *
 * Rule-based English grammar checker with ~15 rules.
 * Detects common errors like double spaces, capitalization, repeated words, etc.
 */
export async function express(input: GrammarInput): Promise<GrammarOutput> {
  const text = (input.text || "").trim();
  const strict = input.strict ?? false;

  if (!text) {
    return { issues: [], score: 100, summary: "No text provided." };
  }

  const issues: GrammarIssue[] = [];

  for (const rule of RULES) {
    if (rule.strict && !strict) continue;

    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      issues.push({
        rule: rule.id,
        message: rule.message,
        position: match.index,
        suggestion: rule.suggestion(match),
      });
      if (!regex.global) break;
    }
  }

  issues.sort((a, b) => a.position - b.position);

  const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
  const penalty = Math.min(issues.length * 5, 100);
  const score = Math.max(0, 100 - penalty);

  const summary =
    issues.length === 0
      ? `No issues found in ${wordCount} words. Clean text!`
      : `Found ${issues.length} issue${issues.length > 1 ? "s" : ""} in ${wordCount} words.`;

  return { issues, score, summary };
}
