import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideBadgeAction,
  uploadSafetyBadge,
  BADGE_WORKER_URL,
} from "../../src/cloud/badge.js";
import type { ScanResult } from "../../src/scanner/types.js";

const VALID_UUID = "12345678-1234-1234-1234-123456789abc";
const TOKEN = "test-badge-token";
const SCANNER_VERSION = "0.8.0";

function fakeScanResult(grade: ScanResult["grade"], findings: ScanResult["findings"] = []): ScanResult {
  return {
    skill_id: "test-gene",
    grade,
    findings,
    stats: { files_scanned: 1, lines_of_code: 10 },
  };
}

// ─── decideBadgeAction (pure decision matrix) ─────────────────

describe("decideBadgeAction (v0.9 §3.8 Phase 1 decision matrix)", () => {
  it("default (no flags, scan ran) → upload self-reported", () => {
    const action = decideBadgeAction({ hasScanResult: true });
    expect(action).toEqual({ kind: "upload", mode: "self-reported" });
  });

  it("--skip-vg (scan ran) → upload skipped placeholder (overrides scanResult)", () => {
    const action = decideBadgeAction({ skipVg: true, hasScanResult: true });
    expect(action).toEqual({ kind: "upload", mode: "skipped" });
  });

  it("--skip-vg --skip-security (no scan ran) → upload skipped placeholder", () => {
    const action = decideBadgeAction({ skipVg: true, skipSecurity: true, hasScanResult: false });
    expect(action).toEqual({ kind: "upload", mode: "skipped" });
  });

  it("--skip-security alone (no scan ran, no skip-vg) → no badge upload", () => {
    const action = decideBadgeAction({ skipSecurity: true, hasScanResult: false });
    expect(action.kind).toBe("skip");
    if (action.kind === "skip") {
      expect(action.reason).toContain("--skip-vg");
    }
  });

  it("no scan result + no flags → no badge upload (defensive)", () => {
    const action = decideBadgeAction({ hasScanResult: false });
    expect(action.kind).toBe("skip");
  });
});

// ─── uploadSafetyBadge (fetch mock) ───────────────────────────

describe("uploadSafetyBadge (fetch wire format)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("self-reported mode posts grade + findings_count + Bearer token", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const scan = fakeScanResult("A", []);

    const r = await uploadSafetyBadge(VALID_UUID, scan, SCANNER_VERSION, "self-reported", TOKEN);

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BADGE_WORKER_URL}/safety/${VALID_UUID}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.gene_id).toBe(VALID_UUID);
    expect(body.scanner_version).toBe(SCANNER_VERSION);
    expect(body.mode).toBe("self-reported");
    expect(body.grade).toBe("A");
    expect(body.findings_count).toBe(0);
  });

  it("skipped mode posts mode=skipped without grade/findings_count", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const r = await uploadSafetyBadge(VALID_UUID, null, SCANNER_VERSION, "skipped", TOKEN);

    expect(r.ok).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe("skipped");
    expect(body.gene_id).toBe(VALID_UUID);
    expect(body.scanner_version).toBe(SCANNER_VERSION);
    expect(body.grade).toBeUndefined();
    expect(body.findings_count).toBeUndefined();
  });

  it("self-reported with null scanResult is rejected before fetch", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    const r = await uploadSafetyBadge(VALID_UUID, null, SCANNER_VERSION, "self-reported", TOKEN);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("scanResult");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("non-2xx response surfaces status + error text without throwing", async () => {
    fetchSpy.mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );

    const r = await uploadSafetyBadge(VALID_UUID, fakeScanResult("A"), SCANNER_VERSION, "self-reported", TOKEN);

    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toBe("unauthorized");
  });

  it("network error is captured, not thrown (publish must not block on badge failures)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const r = await uploadSafetyBadge(VALID_UUID, fakeScanResult("B"), SCANNER_VERSION, "self-reported", TOKEN);

    expect(r.ok).toBe(false);
    expect(r.error).toBe("ECONNREFUSED");
  });

  it("custom workerUrl honored (for testing / staging)", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await uploadSafetyBadge(
      VALID_UUID,
      fakeScanResult("A"),
      SCANNER_VERSION,
      "self-reported",
      TOKEN,
      "https://staging.badge.example",
    );

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe(`https://staging.badge.example/safety/${VALID_UUID}`);
  });

  it("findings_count reflects actual scan findings length", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const scan = fakeScanResult("C", [
      { rule: "r1", severity: "HIGH", file: "a.ts", line: 1, snippet: "x" },
      { rule: "r2", severity: "MEDIUM", file: "b.ts", line: 2, snippet: "y" },
    ]);

    await uploadSafetyBadge(VALID_UUID, scan, SCANNER_VERSION, "self-reported", TOKEN);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.findings_count).toBe(2);
    expect(body.grade).toBe("C");
  });
});
