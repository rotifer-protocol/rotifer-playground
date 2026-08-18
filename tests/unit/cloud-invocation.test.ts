import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI half of the invocation record behind the §33.4 anti-manipulation
 * metrics. Three gates, each documented to users and each identical to the MCP
 * server's: Cloud identity present, signed in, telemetry not switched off.
 * Every branch below is one of those gates; the last two are the shape of the
 * request when all three pass.
 */

const { loadCredentialsMock } = vi.hoisted(() => ({ loadCredentialsMock: vi.fn() }));
vi.mock("../../src/cloud/auth.js", () => ({ loadCredentials: loadCredentialsMock }));

const CLOUD_ID = "250243be-4f02-4a29-8d8a-fe8bc3609c76";
const USER_ID = "3fcaab49-3b61-4e75-9268-5bf90394b947";

function makeGeneDir(manifest?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rotifer-inv-"));
  const geneDir = join(dir, "genes", "some-gene");
  mkdirSync(geneDir, { recursive: true });
  writeFileSync(join(geneDir, "phenotype.json"), JSON.stringify({ domain: "test", fidelity: "Wrapped" }));
  if (manifest !== undefined) {
    writeFileSync(join(geneDir, ".cloud-manifest.json"), JSON.stringify(manifest));
  }
  return geneDir;
}

describe("recordGeneInvocation", () => {
  const savedEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  const dirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    delete process.env.ROTIFER_TELEMETRY;
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    loadCredentialsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  function trackDir(geneDir: string): string {
    dirs.push(join(geneDir, "..", ".."));
    return geneDir;
  }

  it("reports a Cloud-installed Gene when signed in and telemetry is on", async () => {
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    const out = recordGeneInvocation(geneDir);

    expect(out.reported).toBe(CLOUD_ID);
    expect(out.reason).toBeUndefined();
    // The in-flight promise is what callers await before process.exit.
    expect(out.settled).toBeInstanceOf(Promise);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Host comes from ~/.rotifer/cloud.json when present; the path is what matters here.
    expect(String(url)).toMatch(/\/rest\/v1\/rpc\/log_gene_invocation$/);
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_gene_id: CLOUD_ID,
      p_caller_agent_id: USER_ID,
    });
  });

  it("stays silent for a locally-authored Gene (no Cloud identity to report)", async () => {
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = trackDir(makeGeneDir());
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(recordGeneInvocation(geneDir)).toEqual({ reported: null, reason: "no-cloud-identity" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays silent when signed out — nothing is sent, not even anonymously", async () => {
    loadCredentialsMock.mockReturnValue(null);
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(recordGeneInvocation(geneDir)).toEqual({ reported: null, reason: "not-logged-in" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["0", "false", "off", " OFF "])("stays silent when ROTIFER_TELEMETRY=%j", async (flag) => {
    process.env.ROTIFER_TELEMETRY = flag;
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(recordGeneInvocation(geneDir)).toEqual({ reported: null, reason: "telemetry-off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat other ROTIFER_TELEMETRY values as an opt-out", async () => {
    process.env.ROTIFER_TELEMETRY = "no";
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(recordGeneInvocation(geneDir).reported).toBe(CLOUD_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never sends a name-shaped or malformed id", async () => {
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = trackDir(makeGeneDir({ cloud_id: "json-validator" }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(recordGeneInvocation(geneDir)).toEqual({ reported: null, reason: "no-cloud-identity" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws or blocks when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(() => recordGeneInvocation(geneDir)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the rejection settle
  });
});

/**
 * Regression for the first real end-to-end run (2026-08-18): the report is
 * fire-and-forget, and every CLI path that reports and then exits non-zero
 * called `process.exit(1)` immediately after — which terminates the process
 * without waiting for the pending request. The POST never left, `.then` never
 * ran, so not even the ROTIFER_DEBUG line appeared. `gene_invocation_log` stayed
 * at zero rows while the CLI reported "success" on its own wiring.
 *
 * Callers that are about to exit must await flushInvocationReports() first.
 * It has to settle, and it has to give up rather than hang a run forever.
 */
describe("flushInvocationReports", () => {
  const savedEnv = { ...process.env };
  const dirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    delete process.env.ROTIFER_TELEMETRY;
    loadCredentialsMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  function signedInGeneDir(): string {
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    const geneDir = makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" });
    dirs.push(join(geneDir, "..", ".."));
    return geneDir;
  }

  it("resolves immediately when nothing is in flight", async () => {
    const { flushInvocationReports } = await import("../../src/cloud/invocation.js");
    await expect(flushInvocationReports(50)).resolves.toBeUndefined();
  });

  it("waits for an in-flight report to settle", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const { recordGeneInvocation, flushInvocationReports } = await import("../../src/cloud/invocation.js");

    const report = recordGeneInvocation(signedInGeneDir());
    expect(report.reported).toBe(CLOUD_ID);

    let flushed = false;
    const flushing = flushInvocationReports(5000).then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false); // still pending — this is the exit that used to kill it

    release(new Response(null, { status: 204 }));
    await flushing;
    expect(flushed).toBe(true);
  });

  it("gives up after the timeout rather than hanging the run", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => { /* never settles */ })));
    const { recordGeneInvocation, flushInvocationReports } = await import("../../src/cloud/invocation.js");
    recordGeneInvocation(signedInGeneDir());
    await expect(flushInvocationReports(30)).resolves.toBeUndefined();
  });

  it("stops tracking a report once it settles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const { recordGeneInvocation, flushInvocationReports } = await import("../../src/cloud/invocation.js");
    const report = recordGeneInvocation(signedInGeneDir());
    await report.settled;
    // Nothing left to wait for: a zero timeout still resolves.
    await expect(flushInvocationReports(0)).resolves.toBeUndefined();
  });

  it("exposes no settled promise when a gate blocked the report", async () => {
    process.env.ROTIFER_TELEMETRY = "0";
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");
    const report = recordGeneInvocation(signedInGeneDir());
    expect(report.reported).toBeNull();
    expect(report.settled).toBeUndefined();
  });
});
