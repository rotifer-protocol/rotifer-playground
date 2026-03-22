export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";
export type Grade = "A" | "B" | "C" | "D" | "?";

export interface ScanRule {
  id: string;
  description: string;
  severity: Severity;
  patterns: RegExp[];
}

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  snippet: string;
  note?: string;
}

export interface ScanResult {
  skill_id: string;
  scanned_at: string;
  grade: Grade;
  findings: Finding[];
  stats: {
    files_scanned: number;
    lines_of_code: number;
  };
}
