export function express(input: { prompt: string }): {
  result: string;
} {
  const text = (input && input.prompt) || "";
  const citations = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  interface ParsedCitation {
    raw: string;
    format: string;
    fields: Record<string, string>;
  }

  interface InvalidCitation {
    raw: string;
    detectedFormat: string;
    errors: string[];
  }

  const valid: ParsedCitation[] = [];
  const invalid: InvalidCitation[] = [];

  const apaJournal = /^([A-Z][a-zA-Z'-]+(?:,\s*[A-Z]\.\s*[A-Z]?\.?\s*)?(?:,?\s*&\s*[A-Z][a-zA-Z'-]+(?:,\s*[A-Z]\.\s*[A-Z]?\.?\s*)?)*)\s*\((\d{4})\)\.\s+(.+?)\.\s+(.+?),\s*(\d+)(?:\((\d+)\))?,\s*(\d+[-–]\d+)\./;
  const apaLoose = /\(\d{4}\)\./;

  const mlaJournal = /^([A-Z][a-zA-Z'-]+(?:,\s*[A-Za-z ]+)?(?:,?\s*(?:and|et al\.?)\s+[A-Z][a-zA-Z'-]+(?:,\s*[A-Za-z ]+)?)*)\.\s+"(.+?)"\s+(.+?),\s*vol\.\s*(\d+),\s*no\.\s*(\d+),\s*(\d{4}),\s*pp\.\s*(\d+[-–]\d+)\./;
  const mlaLoose = /"\s*.+?"\s+.+?,\s*vol\./i;

  const chicagoJournal = /^([A-Z][a-zA-Z'-]+(?:,\s*[A-Za-z ]+)?(?:,?\s*(?:and)\s+[A-Z][a-zA-Z'-]+(?:,\s*[A-Za-z ]+)?)*)\.\s+"(.+?)"\s+(.+?)\s+(\d+),\s*no\.\s*(\d+)\s*\((\d{4})\):\s*(\d+[-–]\d+)\./;
  const chicagoLoose = /no\.\s*\d+\s*\(\d{4}\)/;

  for (const cite of citations) {
    const apaMatch = cite.match(apaJournal);
    if (apaMatch) {
      valid.push({
        raw: cite,
        format: "APA",
        fields: {
          author: apaMatch[1],
          year: apaMatch[2],
          title: apaMatch[3],
          journal: apaMatch[4],
          volume: apaMatch[5],
          issue: apaMatch[6] || "",
          pages: apaMatch[7],
        },
      });
      continue;
    }

    const mlaMatch = cite.match(mlaJournal);
    if (mlaMatch) {
      valid.push({
        raw: cite,
        format: "MLA",
        fields: {
          author: mlaMatch[1],
          title: mlaMatch[2],
          journal: mlaMatch[3],
          volume: mlaMatch[4],
          issue: mlaMatch[5],
          year: mlaMatch[6],
          pages: mlaMatch[7],
        },
      });
      continue;
    }

    const chicagoMatch = cite.match(chicagoJournal);
    if (chicagoMatch) {
      valid.push({
        raw: cite,
        format: "Chicago",
        fields: {
          author: chicagoMatch[1],
          title: chicagoMatch[2],
          journal: chicagoMatch[3],
          volume: chicagoMatch[4],
          issue: chicagoMatch[5],
          year: chicagoMatch[6],
          pages: chicagoMatch[7],
        },
      });
      continue;
    }

    const errors: string[] = [];
    let detected = "Unknown";

    if (apaLoose.test(cite)) {
      detected = "APA";
      if (!/\(\d{4}\)/.test(cite)) errors.push("Missing or malformed year in parentheses");
      if (!/^[A-Z]/.test(cite)) errors.push("Author name should start with capital letter");
      if (!/,\s*\d+/.test(cite)) errors.push("Missing volume number");
      if (!/\d+[-–]\d+/.test(cite)) errors.push("Missing page range");
      if (!/\.\s*$/.test(cite)) errors.push("Citation should end with a period");
    } else if (mlaLoose.test(cite)) {
      detected = "MLA";
      if (!/"/.test(cite)) errors.push("Title should be in quotation marks");
      if (!/pp\./.test(cite)) errors.push("Missing 'pp.' before page range");
      if (!/,\s*\d{4}/.test(cite)) errors.push("Missing year");
      if (!/\.\s*$/.test(cite)) errors.push("Citation should end with a period");
    } else if (chicagoLoose.test(cite)) {
      detected = "Chicago";
      if (!/"/.test(cite)) errors.push("Title should be in quotation marks");
      if (!/\(\d{4}\)/.test(cite)) errors.push("Year should be in parentheses");
      if (!/:\s*\d+/.test(cite)) errors.push("Missing colon before page range");
      if (!/\.\s*$/.test(cite)) errors.push("Citation should end with a period");
    } else {
      if (!/\d{4}/.test(cite)) errors.push("No year detected");
      if (!/^[A-Z]/.test(cite)) errors.push("Missing author (should start with capital letter)");
      if (cite.length < 20) errors.push("Citation appears too short to be complete");
      if (!/\./.test(cite)) errors.push("Missing punctuation");
      errors.push("Could not match APA, MLA, or Chicago format");
    }

    invalid.push({ raw: cite, detectedFormat: detected, errors });
  }

  const total = valid.length + invalid.length;
  const output = {
    validCitations: valid,
    invalidCitations: invalid,
    stats: {
      total,
      valid: valid.length,
      invalid: invalid.length,
      complianceRate: total > 0 ? `${Math.round((valid.length / total) * 100)}%` : "N/A",
      formatBreakdown: {
        APA: valid.filter((v) => v.format === "APA").length,
        MLA: valid.filter((v) => v.format === "MLA").length,
        Chicago: valid.filter((v) => v.format === "Chicago").length,
      },
    },
    summary: total === 0
      ? "No citations provided for analysis."
      : invalid.length === 0
        ? `All ${total} citations are properly formatted.`
        : `${invalid.length} of ${total} citations have formatting issues.`,
  };

  return { result: JSON.stringify(output, null, 2) };
}
