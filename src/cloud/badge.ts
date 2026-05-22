import type { ScanResult } from "../scanner/types.js";

export const BADGE_WORKER_URL = "https://badge.rotifer.dev";

export type SafetyMode = "self-reported" | "skipped";

export interface SafetyUploadResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface BadgeActionContext {
  skipVg?: boolean;
  skipSecurity?: boolean;
  hasScanResult: boolean;
}

export type BadgeAction =
  | { kind: "upload"; mode: SafetyMode }
  | { kind: "skip"; reason: string };

/**
 * Decide whether to upload a V(g) Safety Badge after publish, and in which mode.
 *
 * Pure function — no I/O, no logging. Tested independently of fetch.
 *
 * Decision matrix (v0.9 §3.8 Phase 1):
 *   skipVg=false, hasScanResult=true  → upload self-reported
 *   skipVg=true                        → upload skipped (intent: explicit)
 *   skipVg=false, hasScanResult=false  → no upload (intent unclear; e.g. --skip-security used alone)
 */
export function decideBadgeAction(ctx: BadgeActionContext): BadgeAction {
  if (ctx.skipVg) {
    return { kind: "upload", mode: "skipped" };
  }
  if (ctx.hasScanResult) {
    return { kind: "upload", mode: "self-reported" };
  }
  return { kind: "skip", reason: "no scan result; pass --skip-vg to upload skipped placeholder" };
}

/**
 * Upload V(g) safety badge to the Badge Worker.
 *
 * - mode="self-reported": requires scanResult; uploads grade + findings_count
 * - mode="skipped": scanResult ignored; uploads sentinel record (badge will display "skipped")
 *
 * Returns `{ ok }` instead of throwing — callers (e.g. `rotifer publish`) MUST
 * NOT block on badge upload failures (badge is observability, not protocol).
 */
export async function uploadSafetyBadge(
  geneId: string,
  scanResult: ScanResult | null,
  scannerVersion: string,
  mode: SafetyMode,
  token: string,
  workerUrl: string = BADGE_WORKER_URL,
): Promise<SafetyUploadResult> {
  const body: Record<string, unknown> = {
    gene_id: geneId,
    scanner_version: scannerVersion,
    mode,
  };

  if (mode === "self-reported") {
    if (!scanResult) {
      return { ok: false, error: "self-reported mode requires scanResult" };
    }
    body.grade = scanResult.grade;
    body.findings_count = scanResult.findings.length;
  }

  try {
    const res = await fetch(`${workerUrl}/safety/${geneId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return { ok: true, status: res.status };
    }
    const errText = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: errText };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
