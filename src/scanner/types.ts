export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";
export type Grade = "A" | "B" | "C" | "D" | "?";

export interface ScanRule {
  id: string;
  description: string;
  severity: Severity;
  patterns: RegExp[];
  /**
   * "code": in JS/TS files, match against the line with string, template and
   * regex literal bodies and comments blanked out (see literals.ts), so text
   * that merely names a call is not a finding. Other file types, and rules
   * without this field, match the raw line.
   */
  matchOn?: "code";
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
