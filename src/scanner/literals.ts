// Blanks out the parts of JavaScript / TypeScript source that cannot execute —
// string, template and regex literal bodies and comments — so a rule can tell a
// real `eval(` call from the text "eval() usage" or the regex /\beval\s*\(/.
// Delimiters stay in place and every masked character becomes a space, so
// column positions and line count are unchanged.
//
// The masker is deliberately conservative: when a `/` could be either division
// or the start of a regex, it is treated as division, and anything it does not
// recognise stays visible as code. A wrong guess therefore costs at most a
// false positive, never a hidden call. Template literals and block comments are
// tracked across lines, because a backtick that closes a template opened on an
// earlier line puts what follows it back in code.

// Characters after which a `/` cannot be division, so it starts a regex.
// `)`, `]` and `}` are absent on purpose: after them a `/` is usually division.
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

// Keywords after which an expression (and so a regex) starts.
const REGEX_AFTER_KEYWORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function maskJsLiterals(lines: string[]): string[] {
  const out: string[] = [];

  // State carried across lines.
  let isInBlockComment = false;
  let isInTemplate = false;
  // For each open `${`, the brace depth to return to when it closes.
  const templateStack: number[] = [];
  let braceDepth = 0;
  // Last two significant code characters, and the last keyword-able word.
  let prev = "";
  let prev2 = "";
  let prevWord = "";

  const setPrev = (ch: string) => {
    prev2 = prev;
    prev = ch;
    prevWord = "";
  };

  const regexAllowed = (): boolean => {
    if (prevWord) return REGEX_AFTER_KEYWORD.has(prevWord);
    // `a++ / b` and `a-- / b` are division.
    if ((prev === "+" && prev2 === "+") || (prev === "-" && prev2 === "-")) return false;
    // Start of file: no preceding token. A `/` at the start of a later line
    // continues the previous line's expression, so `prev` decides it there.
    if (prev === "") return true;
    return REGEX_AFTER_PUNCT.has(prev);
  };

  for (const line of lines) {
    const chars = line.split("");
    const n = chars.length;
    let i = 0;

    const blank = (from: number, to: number) => {
      for (let k = from; k < to && k < n; k++) chars[k] = " ";
    };

    while (i < n) {
      if (isInBlockComment) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          blank(i, n);
          i = n;
        } else {
          blank(i, end);
          i = end + 2;
          isInBlockComment = false;
        }
        continue;
      }

      if (isInTemplate) {
        const ch = line[i];
        if (ch === "\\") {
          blank(i, i + 2);
          i += 2;
        } else if (ch === "`") {
          isInTemplate = false;
          i++;
          setPrev("`");
        } else if (ch === "$" && line[i + 1] === "{") {
          templateStack.push(braceDepth);
          braceDepth++;
          isInTemplate = false;
          i += 2;
          setPrev("{");
        } else {
          chars[i] = " ";
          i++;
        }
        continue;
      }

      const ch = line[i];
      const next = line[i + 1];

      if (ch === " " || ch === "\t" || ch === "\r") {
        i++;
        continue;
      }

      if (ch === "/" && next === "/") {
        blank(i + 2, n);
        i = n;
        continue;
      }

      if (ch === "/" && next === "*") {
        isInBlockComment = true;
        i += 2;
        continue;
      }

      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < n && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
        blank(i + 1, Math.min(j, n));
        i = j + 1;
        setPrev(ch);
        continue;
      }

      if (ch === "`") {
        isInTemplate = true;
        i++;
        continue;
      }

      if (ch === "/" && regexAllowed()) {
        let j = i + 1;
        let isInClass = false;
        while (j < n) {
          const c = line[j];
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === "[") isInClass = true;
          else if (c === "]") isInClass = false;
          else if (c === "/" && !isInClass) break;
          j++;
        }
        if (j >= n) {
          // No closing slash on this line: not a regex we can delimit, so leave
          // it as code rather than risk hiding anything.
          setPrev("/");
          i++;
          continue;
        }
        blank(i + 1, j);
        i = j + 1;
        while (i < n && /[a-z]/.test(line[i])) i++;
        setPrev("/");
        continue;
      }

      if (IDENT_CHAR.test(ch)) {
        let j = i;
        while (j < n && IDENT_CHAR.test(line[j])) j++;
        const word = line.slice(i, j);
        // A property name such as `obj.return` is not a keyword.
        const isProperty = prev === ".";
        prev2 = prev;
        prev = line[j - 1];
        prevWord = isProperty ? "" : word;
        i = j;
        continue;
      }

      if (ch === "{") {
        braceDepth++;
      } else if (ch === "}") {
        braceDepth--;
        if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
          templateStack.pop();
          isInTemplate = true;
          i++;
          continue;
        }
      }
      setPrev(ch);
      i++;
    }

    out.push(chars.join(""));
  }

  return out;
}
