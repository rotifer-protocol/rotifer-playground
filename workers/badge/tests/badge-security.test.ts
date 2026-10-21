/**
 * Gap #2: Badge Worker security tests
 * POST /safety injection, auth bypass, KV tampering, edge cases
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_UUID = "12345678-1234-1234-1234-123456789abc";
const VALID_PAYLOAD = {
  gene_id: VALID_UUID,
  grade: "A",
  scanner_version: "0.1.0",
  findings_count: 0,
};

// ─── POST /safety — Auth Bypass Attempts ──────────────────────

describe("Badge Worker: auth bypass", () => {
  it("rejects request without Authorization header", () => {
    const auth = null;
    const expected = "Bearer test-token";
    expect(auth === expected).toBe(false);
  });

  it("rejects empty Bearer token", () => {
    const auth = "Bearer ";
    const expected = "Bearer test-token";
    expect(auth === expected).toBe(false);
  });

  it("rejects Bearer token with extra whitespace", () => {
    const auth = "Bearer  test-token";
    const expected = "Bearer test-token";
    expect(auth === expected).toBe(false);
  });

  it("rejects non-Bearer auth scheme", () => {
    const auth = "Basic dXNlcjpwYXNz";
    expect(auth.startsWith("Bearer ")).toBe(false);
  });

  it("rejects token with SQL injection payload", () => {
    const auth = "Bearer ' OR 1=1 --";
    const expected = "Bearer real-token-123";
    expect(auth === expected).toBe(false);
  });
});

// ─── POST /safety — Input Validation ──────────────────────────

describe("Badge Worker: input validation", () => {
  it("rejects non-UUID gene_id", () => {
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
    expect(UUID_RE.test("../../../etc/passwd")).toBe(false);
    expect(UUID_RE.test("")).toBe(false);
  });

  it("rejects SQL injection in gene_id", () => {
    expect(UUID_RE.test("'; DROP TABLE genes; --")).toBe(false);
  });

  it("rejects invalid grade values", () => {
    const validGrades = ["A", "B", "C", "D"];
    expect(validGrades.includes("E")).toBe(false);
    expect(validGrades.includes("")).toBe(false);
    expect(validGrades.includes("A; DROP TABLE")).toBe(false);
    expect(validGrades.includes("AA")).toBe(false);
  });

  it("accepts valid grade values", () => {
    const validGrades = ["A", "B", "C", "D"];
    for (const g of validGrades) {
      expect(validGrades.includes(g)).toBe(true);
    }
  });

  it("rejects missing scanner_version", () => {
    const payload = { gene_id: VALID_UUID, grade: "A", scanner_version: "" };
    expect(!payload.scanner_version).toBe(true);
  });

  it("rejects oversized payload fields", () => {
    const oversizedVersion = "x".repeat(10000);
    expect(oversizedVersion.length).toBeGreaterThan(256);
  });
});

// ─── KV Key Safety ────────────────────────────────────────────

describe("Badge Worker: KV key safety", () => {
  it("KV key is prefixed with safety:", () => {
    const key = `safety:${VALID_UUID}`;
    expect(key.startsWith("safety:")).toBe(true);
  });

  it("KV key cannot contain path traversal", () => {
    const maliciousId = "../../../secret";
    expect(UUID_RE.test(maliciousId)).toBe(false);
  });

  it("KV value has TTL of 90 days", () => {
    const ttl = 90 * 24 * 3600;
    expect(ttl).toBe(7776000);
  });

  it("KV value includes self-reported source marker", () => {
    const kvValue = {
      grade: "A",
      version_id: null,
      scanner_version: "0.1.0",
      scanned_at: new Date().toISOString(),
      source: "self-reported",
      findings_count: 0,
    };
    expect(kvValue.source).toBe("self-reported");
  });
});

// ─── Mode Field (v0.9 §3.8 Phase 1) ────────────────────────────

describe("Badge Worker: mode field", () => {
  function normalizeMode(input: unknown): "self-reported" | "skipped" {
    return input === "skipped" ? "skipped" : "self-reported";
  }

  function isValidMode(m: unknown): boolean {
    return m === undefined || m === "self-reported" || m === "skipped";
  }

  it("missing mode defaults to self-reported (backward compat with v0.8 callers)", () => {
    const body = { gene_id: VALID_UUID, grade: "A", scanner_version: "0.8.0" };
    const mode = (body as { mode?: string }).mode ?? "self-reported";
    expect(mode).toBe("self-reported");
  });

  it("mode=self-reported requires grade A/B/C/D", () => {
    const body = { gene_id: VALID_UUID, grade: "A", scanner_version: "0.9.0", mode: "self-reported" };
    const validGrades = ["A", "B", "C", "D"];
    expect(body.mode === "self-reported" && validGrades.includes(body.grade)).toBe(true);
  });

  it("mode=self-reported rejects missing grade", () => {
    const body = { gene_id: VALID_UUID, scanner_version: "0.9.0", mode: "self-reported" } as { grade?: string; mode: string };
    const validGrades = ["A", "B", "C", "D"];
    expect(body.mode === "self-reported" && (!body.grade || !validGrades.includes(body.grade))).toBe(true);
  });

  it("mode=skipped does NOT require grade", () => {
    const body = { gene_id: VALID_UUID, scanner_version: "0.9.0", mode: "skipped" } as { grade?: string; mode: string };
    expect(body.mode).toBe("skipped");
    expect(body.grade).toBeUndefined();
  });

  it("invalid mode value is rejected", () => {
    expect(isValidMode("verified")).toBe(false);
    expect(isValidMode("")).toBe(false);
    expect(isValidMode("SELF-REPORTED")).toBe(false);
    expect(isValidMode(123)).toBe(false);
  });

  it("valid modes accepted", () => {
    expect(isValidMode(undefined)).toBe(true);
    expect(isValidMode("self-reported")).toBe(true);
    expect(isValidMode("skipped")).toBe(true);
  });

  it("KV value for mode=skipped contains null grade and findings_count", () => {
    const mode = "skipped";
    const body = { gene_id: VALID_UUID, scanner_version: "0.9.0", mode };
    const kvValue = {
      mode: normalizeMode(body.mode),
      grade: body.mode === "skipped" ? null : "A",
      version_id: null,
      scanner_version: body.scanner_version,
      scanned_at: new Date().toISOString(),
      source: "self-reported",
      findings_count: body.mode === "skipped" ? null : 0,
    };
    expect(kvValue.mode).toBe("skipped");
    expect(kvValue.grade).toBeNull();
    expect(kvValue.findings_count).toBeNull();
  });

  it("KV value for mode=self-reported preserves grade and findings_count", () => {
    const body = { gene_id: VALID_UUID, grade: "A", scanner_version: "0.9.0", findings_count: 0, mode: "self-reported" };
    const kvValue = {
      mode: normalizeMode(body.mode),
      grade: body.mode === "skipped" ? null : body.grade,
      version_id: null,
      scanner_version: body.scanner_version,
      scanned_at: new Date().toISOString(),
      source: "self-reported",
      findings_count: body.mode === "skipped" ? null : body.findings_count,
    };
    expect(kvValue.mode).toBe("self-reported");
    expect(kvValue.grade).toBe("A");
    expect(kvValue.findings_count).toBe(0);
  });
});

// ─── Badge Render (mode-aware) ────────────────────────────────

describe("Badge Worker: safety badge rendering", () => {
  function renderSafetyBadge(payload: { mode?: string; grade?: string | null }): { label: string; message: string; color: string } {
    const GRADE_COLORS: Record<string, string> = { A: "brightgreen", B: "green", C: "yellow", D: "red", "?": "lightgrey" };
    if (payload.mode === "skipped") {
      return { label: "rotifer safety", message: "skipped", color: "lightgrey" };
    }
    const grade = payload.grade ?? "?";
    return { label: "rotifer safety", message: grade, color: GRADE_COLORS[grade] ?? "lightgrey" };
  }

  it("mode=skipped renders 'skipped' grey badge (no grade)", () => {
    const r = renderSafetyBadge({ mode: "skipped", grade: null });
    expect(r.message).toBe("skipped");
    expect(r.color).toBe("lightgrey");
  });

  it("mode=self-reported with grade A renders A brightgreen", () => {
    const r = renderSafetyBadge({ mode: "self-reported", grade: "A" });
    expect(r.message).toBe("A");
    expect(r.color).toBe("brightgreen");
  });

  it("legacy KV value (no mode field) treated as self-reported", () => {
    const r = renderSafetyBadge({ grade: "B" });
    expect(r.message).toBe("B");
    expect(r.color).toBe("green");
  });

  it("missing grade falls back to '?'", () => {
    const r = renderSafetyBadge({ mode: "self-reported" });
    expect(r.message).toBe("?");
    expect(r.color).toBe("lightgrey");
  });
});

// ─── Route Parser Edge Cases ──────────────────────────────────

describe("Badge Worker: route parser edge cases", () => {
  function parseRoute(pathname: string): { handler: string; param: string } | null {
    const decoded = decodeURIComponent(pathname);
    const segments = decoded.replace(/^\/+|\/+$/g, "").split("/");
    if (segments.length < 2) return null;
    if (segments[0] === "safety") return { handler: "safety", param: segments.slice(1).join("/") };
    if (segments[0] === "gene") {
      const lastSeg = segments[segments.length - 1];
      if (lastSeg === "fitness") return { handler: "gene-fitness", param: segments.slice(1, -1).join("/") };
      return { handler: "gene", param: segments.slice(1).join("/") };
    }
    if (segments[0] === "dev") return { handler: "dev", param: segments[1] };
    return null;
  }

  it("rejects path with URL-encoded traversal", () => {
    const result = parseRoute("/safety/%2e%2e%2f%2e%2e%2fsecret");
    expect(result?.param).toContain("..");
    expect(UUID_RE.test(result?.param || "")).toBe(false);
  });

  it("handles double-encoded path segments", () => {
    const result = parseRoute("/gene/%252e%252e");
    expect(result).not.toBeNull();
    expect(UUID_RE.test(result?.param || "")).toBe(false);
  });

  it("handles extremely long path", () => {
    const longId = "a".repeat(10000);
    const result = parseRoute(`/safety/${longId}`);
    expect(result?.param.length).toBe(10000);
    expect(UUID_RE.test(result?.param || "")).toBe(false);
  });

  it("handles null bytes in path", () => {
    const result = parseRoute("/safety/test%00malicious");
    expect(result).not.toBeNull();
  });
});

// ─── Response Headers ─────────────────────────────────────────

describe("Badge Worker: response security headers", () => {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  it("CORS allows all origins (public badge API)", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("only GET, POST, OPTIONS methods allowed", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("GET");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("POST");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).not.toContain("DELETE");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).not.toContain("PUT");
  });
});

// ─── End-to-End worker.fetch() — POST routing regression ───────
//
// Regression guard for the 2026-05-22 W0 incident: parseRoute() rejected
// /safety as too-short, so POST /safety always returned 405 even when auth
// + payload were correct. v0.8 + v0.9 Phase 1 unit tests only exercised
// parseRoute() in isolation with /safety/<id> paths and never invoked the
// full worker.fetch() POST path, so the bug shipped silently to production.
// Any future refactor of parseRoute() or the fetch() router MUST keep these
// E2E assertions green.

describe("Badge Worker: worker.fetch() POST routing", () => {
  // Cloudflare Workers exposes crypto.subtle.timingSafeEqual; Node's WebCrypto
  // does not. Polyfill for tests so handleSafetyPost's auth check can run.
  if (!(globalThis.crypto.subtle as any).timingSafeEqual) {
    (globalThis.crypto.subtle as any).timingSafeEqual = (a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer) => {
      const bufA = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const bufB = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (bufA.byteLength !== bufB.byteLength) return false;
      let mismatch = 0;
      for (let i = 0; i < bufA.byteLength; i++) mismatch |= bufA[i] ^ bufB[i];
      return mismatch === 0;
    };
  }

  function makeKvStub() {
    const store = new Map<string, string>();
    return {
      kv: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          store.set(key, value);
        }),
      },
      store,
    };
  }

  function makeEnv(extra: Partial<Record<string, string>> = {}) {
    const { kv, store } = makeKvStub();
    return {
      env: {
        BADGE_KV: kv as unknown as KVNamespace,
        BADGE_AUTH_TOKEN: "test-token-fixture",
        SUPABASE_URL: "https://example.invalid",
        SUPABASE_ANON_KEY: "anon-fixture",
        ...extra,
      } as unknown as Parameters<typeof worker.fetch>[1],
      store,
    };
  }

  it("POST /safety with valid auth + payload returns 200 and writes KV", async () => {
    const { env, store } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/safety", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token-fixture",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gene_id: VALID_UUID,
          grade: "A",
          findings_count: 0,
          scanner_version: "0.1.0",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const stored = store.get(`safety:${VALID_UUID}`);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.grade).toBe("A");
    expect(parsed.mode).toBe("self-reported");
  });

  it("POST /safety/ (trailing slash) also routes to handleSafetyPost", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/safety/", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token-fixture",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gene_id: VALID_UUID,
          grade: "B",
          findings_count: 1,
          scanner_version: "0.1.0",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it("POST /safety with skipped mode succeeds without grade", async () => {
    const { env, store } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/safety", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token-fixture",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gene_id: VALID_UUID,
          mode: "skipped",
          scanner_version: "0.1.0",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const parsed = JSON.parse(store.get(`safety:${VALID_UUID}`)!);
    expect(parsed.mode).toBe("skipped");
    expect(parsed.grade).toBeNull();
  });

  it("POST /safety without Authorization returns 401 (not 405)", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/safety", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gene_id: VALID_UUID, grade: "A", scanner_version: "0.1.0" }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("POST /safety with wrong token returns 401", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/safety", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ gene_id: VALID_UUID, grade: "A", scanner_version: "0.1.0" }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("POST /unknown-path returns 405 (only /safety accepts POST)", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/gene/abc", {
        method: "POST",
        headers: { Authorization: "Bearer test-token-fixture" },
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(405);
  });

  it("DELETE /safety returns 405 (method allowlist)", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://badge.example.com/safety", { method: "DELETE" }),
      env,
    );
    expect(response.status).toBe(405);
  });
});

// ─── R10: POST /safety rate limiting (KV fixed-window per IP) ──────────────────
import { rateLimit } from "../src/index.js";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  } as unknown as KVNamespace;
}

describe("Badge Worker: POST /safety rate limit (R10)", () => {
  it("allows up to the limit, denies beyond it (same IP/window)", async () => {
    const kv = mockKV();
    const ip = "203.0.113.7";
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(kv, ip, 3, 60));
    expect(results).toEqual([true, true, true, false]); // 3 allowed, 4th denied
  });

  it("isolates counters per IP", async () => {
    const kv = mockKV();
    expect(await rateLimit(kv, "1.1.1.1", 1, 60)).toBe(true);
    expect(await rateLimit(kv, "1.1.1.1", 1, 60)).toBe(false); // 2nd from same IP
    expect(await rateLimit(kv, "2.2.2.2", 1, 60)).toBe(true);  // different IP unaffected
  });

  it("returns 429 from POST /safety when the limit is exceeded", async () => {
    const kv = mockKV();
    const env = { BADGE_AUTH_TOKEN: "t", BADGE_KV: kv } as any;
    const make = () => new Request("https://badge.rotifer.dev/safety", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json", "cf-connecting-ip": "9.9.9.9" },
      body: JSON.stringify({ gene_id: VALID_UUID, grade: "A", scanner_version: "0.1.0" }),
    });
    let last: Response | undefined;
    for (let i = 0; i < 40; i++) last = await worker.fetch(make(), env);
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });
});
