const HIGH_CONFIDENCE_CATEGORIES: Record<string, number> = {
  "hardcoded-secret": 0.95,
  "sql-injection": 0.90,
  "xss": 0.85,
  "unsafe-deserialization": 0.80,
  "missing-validation": 0.50,
};

const SEVERITY_BOOST: Record<string, number> = {
  critical: 0.10,
  high: 0.05,
  medium: -0.05,
  low: -0.15,
};

interface Finding {
  severity: string;
  category: string;
  message: string;
  line?: number;
  fix?: string;
}

interface ReviewOutput {
  findings?: Finding[];
  summary?: string;
}

interface FilteredFinding extends Finding {
  confidence: number;
}

interface Rejected {
  originalMessage: string;
  rejectReason: string;
}

export function express(input: { reviewOutput?: ReviewOutput; originalCode?: string }): {
  filteredFindings: FilteredFinding[];
  rejected: Rejected[];
  guardStats: { inputCount: number; outputCount: number; rejectRate: number };
} {
  const review = input.reviewOutput || {};
  const findings: Finding[] = review.findings || [];
  const filtered: FilteredFinding[] = [];
  const rejected: Rejected[] = [];

  for (const f of findings) {
    const sev = (f.severity || "").toLowerCase();

    if (sev !== "critical" && sev !== "high") {
      rejected.push({ originalMessage: f.message || "", rejectReason: `Severity "${sev}" below strict threshold (critical/high only)` });
      continue;
    }

    if (!f.message || f.message.length < 20) {
      rejected.push({ originalMessage: f.message || "", rejectReason: "Message too vague (< 20 characters)" });
      continue;
    }

    if (f.line == null || f.line < 1) {
      rejected.push({ originalMessage: f.message || "", rejectReason: "Missing or invalid line number" });
      continue;
    }

    const baseCat = HIGH_CONFIDENCE_CATEGORIES[f.category] ?? 0.60;
    const sevBoost = SEVERITY_BOOST[sev] ?? 0;
    let confidence = baseCat + sevBoost;

    if (f.fix && f.fix.length > 10) confidence += 0.03;
    confidence = Math.max(0, Math.min(1, parseFloat(confidence.toFixed(2))));

    filtered.push({
      severity: f.severity,
      category: f.category,
      message: f.message,
      line: f.line,
      fix: f.fix,
      confidence,
    });
  }

  const inputCount = findings.length;
  const outputCount = filtered.length;
  const rejectRate = inputCount > 0 ? parseFloat(((inputCount - outputCount) / inputCount).toFixed(2)) : 0;

  return { filteredFindings: filtered, rejected, guardStats: { inputCount, outputCount, rejectRate } };
}
