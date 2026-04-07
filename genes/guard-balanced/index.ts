const CATEGORY_BASE_CONFIDENCE: Record<string, number> = {
  "hardcoded-secret": 0.92,
  "sql-injection": 0.88,
  "xss": 0.82,
  "unsafe-deserialization": 0.75,
  "missing-validation": 0.55,
};

const SEVERITY_MODIFIER: Record<string, number> = {
  critical: 0.08,
  high: 0.04,
  medium: 0.00,
  low: -0.10,
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
    const msgLen = (f.message || "").length;

    if (sev === "critical" || sev === "high") {
      // Always pass critical/high — only reject if message is truly empty
      if (!f.message || msgLen === 0) {
        rejected.push({ originalMessage: "", rejectReason: "Empty message on critical/high finding" });
        continue;
      }
    } else if (sev === "medium") {
      if (msgLen <= 30) {
        rejected.push({ originalMessage: f.message || "", rejectReason: `Medium severity with short message (${msgLen} chars <= 30)` });
        continue;
      }
    } else {
      // low or unknown severity
      if (msgLen <= 30) {
        rejected.push({ originalMessage: f.message || "", rejectReason: `Low severity with short message (${msgLen} chars) — insufficient detail` });
        continue;
      }
    }

    const baseCat = CATEGORY_BASE_CONFIDENCE[f.category] ?? 0.60;
    const sevMod = SEVERITY_MODIFIER[sev] ?? 0;
    let confidence = baseCat + sevMod;

    if (f.line != null && f.line > 0) confidence += 0.03;
    if (f.fix && f.fix.length > 10) confidence += 0.02;
    if (msgLen > 50) confidence += 0.02;
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
