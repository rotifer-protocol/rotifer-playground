// Blanks out the parts of JavaScript / TypeScript source that cannot execute —
// string, template and regex literal bodies and comments — so a rule can tell a
// real `eval(` call from the text "eval() usage" or the regex /\beval\s*\(/.
// Delimiters stay in place and every masked character becomes a space, so
// column positions and line count are unchanged.
//
// What it guarantees, and what it does not:
//
// - A `/` that could be either division or the start of a regex is lexed both
//   ways in parallel, and a character is blanked only if every reading puts it
//   inside a literal or comment. Readings that reach the same state merge; if
//   more than MAX_READINGS are alive at once, masking stops and the rest of the
//   file is left as raw source.
// - A regex is only considered where a closing `/` exists on the same line.
//   Strings continued with a trailing `\` stay strings on the next line;
//   template literals and block comments are tracked across lines; `\r`,
//   U+2028 and U+2029 end a line comment, as they do in JavaScript.
//
// Within those rules, a character that JavaScript executes as code is never
// blanked. It does not make S-01 complete: code it cannot see as a call at
// all, such as globalThis["ev" + "al"](x), was never caught by the raw-line
// patterns either.
//
// Changing this file changes scan results: bump SCANNER_VERSION in rules.ts.
// tests/unit/scanner-rules.test.ts pins this file's hash to make that visible.

const MAX_READINGS = 16;

// After these, a `/` cannot be division, so it starts a regex.
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "&", "|", "?", "{", ";", "*", "%", "<", "~", "^", "/"]);

// After these, a `/` is always division: an identifier, a number or a literal.
const WORD = "w";
const LITERAL = "L";

// Reserved words after which an expression, and so a regex, starts.
const REGEX_AFTER_KEYWORD = new Set([
  "return", "typeof", "instanceof", "in", "new", "delete", "void", "throw",
  "case", "do", "else", "extends", "default",
]);

// Words after which a `/` may be either. `yield`, `await` and `of` are
// identifiers in some contexts. `break` and `continue` get an automatic `;`
// before a line break, so a `/` on the next line starts a regex.
const AMBIGUOUS_WORDS = new Set(["yield", "await", "of", "break", "continue"]);

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const LINE_TERMINATORS = new Set(["\n", "\r", " ", " "]);

type Mode = "code" | "lineComment" | "blockComment" | "string" | "template" | "regex";

interface Reading {
  mode: Mode;
  quote: string;
  isEscaped: boolean;
  regexEnd: number;
  // For each open `${`, the brace depth to return to when it closes.
  templateStack: number[];
  braceDepth: number;
  // Last two significant code tokens (a punctuation character, WORD or LITERAL)
  // and the identifier that produced the last WORD, if any.
  prev: string;
  prev2: string;
  prevWord: string;
  ident: string;
  isPropertyIdent: boolean;
  // Characters still to emit unmasked for a multi-character delimiter.
  skip: number;
}

type SlashKind = "regex" | "division" | "ambiguous";

function slashKind(r: Reading): SlashKind {
  if (r.prev === WORD) {
    if (REGEX_AFTER_KEYWORD.has(r.prevWord)) return "regex";
    if (AMBIGUOUS_WORDS.has(r.prevWord)) return "ambiguous";
    return "division";
  }
  if (r.prev === LITERAL) return "division";
  if (r.prev === "") return "regex";
  // `a++ / b` is division; `a + +/x/` is a regex.
  if ((r.prev === "+" || r.prev === "-") && r.prev2 === r.prev) return "ambiguous";
  // `=>` precedes an expression; any other `>` may close a TypeScript generic.
  if (r.prev === ">") return r.prev2 === "=" ? "regex" : "ambiguous";
  if (REGEX_AFTER_PUNCT.has(r.prev) || r.prev === "+" || r.prev === "-") return "regex";
  // `)`, `]`, `}`, `!` (TypeScript non-null), `.` and anything else.
  return "ambiguous";
}

// Index of the `/` that would close a regex starting at `start`, or -1 if the
// line ends first (then it cannot be a regex).
function findRegexEnd(text: string, start: number): number {
  let isInClass = false;
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j];
    if (LINE_TERMINATORS.has(c)) return -1;
    if (c === "\\") {
      j++;
      if (j < text.length && LINE_TERMINATORS.has(text[j])) return -1;
      continue;
    }
    if (c === "[") isInClass = true;
    else if (c === "]") isInClass = false;
    else if (c === "/" && !isInClass) return j;
  }
  return -1;
}

function setPrev(r: Reading, token: string): void {
  r.prev2 = r.prev;
  r.prev = token;
  r.prevWord = "";
}

function endIdent(r: Reading): void {
  if (!r.ident) return;
  r.prevWord = r.isPropertyIdent ? "" : r.ident;
  r.ident = "";
}

function stateKey(r: Reading): string {
  return JSON.stringify([
    r.mode, r.quote, r.isEscaped, r.regexEnd, r.templateStack, r.braceDepth,
    r.prev, r.prev2, r.prevWord, r.ident, r.isPropertyIdent, r.skip,
  ]);
}

// Advances `r` over text[i]. Returns whether that character is masked, plus
// the alternative reading when text[i] is an ambiguous `/`.
function step(r: Reading, text: string, i: number): { isMasked: boolean; fork?: Reading } {
  const ch = text[i];

  if (r.skip > 0) {
    r.skip--;
    return { isMasked: false };
  }

  switch (r.mode) {
    case "lineComment":
      if (LINE_TERMINATORS.has(ch)) {
        r.mode = "code";
        return { isMasked: false };
      }
      return { isMasked: true };

    case "blockComment":
      if (ch === "*" && text[i + 1] === "/") {
        r.mode = "code";
        r.skip = 1;
        return { isMasked: false };
      }
      return { isMasked: ch !== "\n" };

    case "string":
      if (r.isEscaped) {
        r.isEscaped = false;
        // `\` + CRLF is one line continuation.
        if (ch === "\r" && text[i + 1] === "\n") r.skip = 1;
        return { isMasked: ch !== "\n" && ch !== "\r" };
      }
      if (ch === "\\") {
        r.isEscaped = true;
        return { isMasked: true };
      }
      if (ch === r.quote) {
        r.mode = "code";
        setPrev(r, LITERAL);
        return { isMasked: false };
      }
      if (ch === "\n" || ch === "\r") {
        // Unterminated string: not valid JavaScript. Stop masking here.
        r.mode = "code";
        setPrev(r, LITERAL);
        return { isMasked: false };
      }
      return { isMasked: true };

    case "template":
      if (r.isEscaped) {
        r.isEscaped = false;
        return { isMasked: ch !== "\n" };
      }
      if (ch === "\\") {
        r.isEscaped = true;
        return { isMasked: true };
      }
      if (ch === "`") {
        r.mode = "code";
        setPrev(r, LITERAL);
        return { isMasked: false };
      }
      if (ch === "$" && text[i + 1] === "{") {
        r.templateStack = [...r.templateStack, r.braceDepth];
        r.braceDepth++;
        r.mode = "code";
        r.skip = 1;
        setPrev(r, "{");
        return { isMasked: false };
      }
      return { isMasked: ch !== "\n" };

    case "regex":
      if (i === r.regexEnd) {
        r.mode = "code";
        setPrev(r, LITERAL);
        return { isMasked: false };
      }
      return { isMasked: true };

    case "code":
      break;
  }

  if (IDENT_CHAR.test(ch)) {
    if (!r.ident) {
      r.isPropertyIdent = r.prev === ".";
      setPrev(r, WORD);
    }
    r.ident += ch;
    return { isMasked: false };
  }
  endIdent(r);

  if (ch === " " || ch === "\t" || LINE_TERMINATORS.has(ch)) return { isMasked: false };

  if (ch === "/" && text[i + 1] === "/") {
    r.mode = "lineComment";
    r.skip = 1;
    return { isMasked: false };
  }
  if (ch === "/" && text[i + 1] === "*") {
    r.mode = "blockComment";
    r.skip = 1;
    return { isMasked: false };
  }
  if (ch === "'" || ch === '"') {
    r.mode = "string";
    r.quote = ch;
    return { isMasked: false };
  }
  if (ch === "`") {
    r.mode = "template";
    return { isMasked: false };
  }
  if (ch === "/") {
    const end = findRegexEnd(text, i);
    const kind = end === -1 ? "division" : slashKind(r);
    if (kind === "division") {
      setPrev(r, "/");
      return { isMasked: false };
    }
    if (kind === "ambiguous") {
      const asDivision = cloneReading(r);
      setPrev(asDivision, "/");
      r.mode = "regex";
      r.regexEnd = end;
      return { isMasked: false, fork: asDivision };
    }
    r.mode = "regex";
    r.regexEnd = end;
    return { isMasked: false };
  }
  if (ch === "{") {
    r.braceDepth++;
  } else if (ch === "}") {
    r.braceDepth--;
    const top = r.templateStack[r.templateStack.length - 1];
    if (r.templateStack.length > 0 && r.braceDepth === top) {
      r.templateStack = r.templateStack.slice(0, -1);
      r.mode = "template";
      return { isMasked: false };
    }
  }
  setPrev(r, ch);
  return { isMasked: false };
}

function cloneReading(r: Reading): Reading {
  return { ...r, templateStack: [...r.templateStack] };
}

export function maskJsLiterals(lines: string[]): string[] {
  const text = lines.join("\n");
  const out = text.split("");
  let readings: Reading[] = [{
    mode: "code", quote: "", isEscaped: false, regexEnd: -1, templateStack: [],
    braceDepth: 0, prev: "", prev2: "", prevWord: "", ident: "",
    isPropertyIdent: false, skip: 0,
  }];

  for (let i = 0; i < text.length; i++) {
    let isMaskedEverywhere = true;
    const next: Reading[] = [];
    for (const r of readings) {
      const { isMasked, fork } = step(r, text, i);
      if (!isMasked) isMaskedEverywhere = false;
      next.push(r);
      if (fork) next.push(fork);
    }
    if (isMaskedEverywhere) out[i] = " ";

    if (next.length === 1) {
      readings = next;
      continue;
    }
    const seen = new Set<string>();
    readings = next.filter((r) => {
      const key = stateKey(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Too many readings to follow: leave the rest of the file unmasked.
    if (readings.length > MAX_READINGS) break;
  }

  return out.join("").split("\n");
}
