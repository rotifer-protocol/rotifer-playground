interface FormatterInput {
  markdown: string;
  lineWidth?: number;
  listMarker?: "-" | "*" | "+";
  headingStyle?: "atx" | "setext";
}

interface FormatterOutput {
  formatted: string;
  changed: boolean;
  changeCount: number;
}

export function express(input: FormatterInput): FormatterOutput {
  const src = input.markdown || "";
  const marker = input.listMarker ?? "-";
  let changes = 0;
  const lines = src.split("\n");
  const out: string[] = [];
  let prevBlank = false;
  let prevHeading = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    line = line.replace(/[ \t]+$/, (m) => { if (m) changes++; return ""; });

    const headingMatch = line.match(/^(#{1,6})\s*(.*)/);
    if (headingMatch) {
      const level = headingMatch[1];
      const text = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
      const newLine = `${level} ${text}`;
      if (newLine !== line) changes++;
      if (out.length > 0 && !prevBlank) { out.push(""); changes++; }
      out.push(newLine);
      prevHeading = true;
      prevBlank = false;
      continue;
    }

    if (prevHeading && line.trim() !== "") {
      if (!prevBlank) { out.push(""); changes++; }
      prevHeading = false;
    }

    const listMatch = line.match(/^(\s*)[*+\-]\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1];
      const content = listMatch[2];
      const newLine = `${indent}${marker} ${content}`;
      if (newLine !== line) changes++;
      out.push(newLine);
      prevBlank = false;
      prevHeading = false;
      continue;
    }

    if (line.trim() === "") {
      if (!prevBlank) {
        out.push("");
        prevBlank = true;
      } else {
        changes++;
      }
      prevHeading = false;
      continue;
    }

    out.push(line);
    prevBlank = false;
    prevHeading = false;
  }

  let formatted = out.join("\n");
  if (formatted.length > 0 && !formatted.endsWith("\n")) {
    formatted += "\n";
    if (!src.endsWith("\n")) changes++;
  }

  while (formatted.endsWith("\n\n")) {
    formatted = formatted.slice(0, -1);
    changes++;
  }

  return { formatted, changed: changes > 0, changeCount: changes };
}
