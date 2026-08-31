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
    // The reporter refuses to report under a test runner (see runningUnderTest).
    // These tests exercise the production path, so drop the markers it looks for.
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
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
    // v2 since migration 20260830000000: a plain CLI run is attributed to `cli`
    // rather than left unattributed, so it goes to the entry point that can
    // carry that. The older RPC is still called when no channel can be
    // established — see "falls back to the original RPC" below.
    expect(String(url)).toMatch(/\/rest\/v1\/rpc\/log_gene_invocation_v2$/);
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_gene_id: CLOUD_ID,
      p_caller_agent_id: USER_ID,
      p_client_channel: "cli",
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
    // The reporter refuses to report under a test runner (see runningUnderTest).
    // These tests exercise the production path, so drop the markers it looks for.
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
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

  /**
   * flushInvocationReports() giving up after the timeout (the test above)
   * only stops the *caller* from waiting — found via heartbeat.ts's
   * identical fetch, sharing this exact shape (see
   * tests/e2e/telemetry-heartbeat-delivery.test.ts). A request that never
   * gets a response leaves its socket open as an active handle, and Node
   * does not exit while one exists: without aborting the fetch itself, a
   * stalled telemetry endpoint would hang the whole CLI process for
   * however long the OS's own TCP timeout takes, not just FLUSH_TIMEOUT_MS.
   */
  it("aborts the underlying fetch after FLUSH_TIMEOUT_MS, not just the caller's wait", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { recordGeneInvocation, FLUSH_TIMEOUT_MS } = await import("../../src/cloud/invocation.js");

    recordGeneInvocation(signedInGeneDir());
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS);
    expect(capturedSignal!.aborted).toBe(true);

    vi.useRealTimers();
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

/**
 * Regression for 2026-08-18: `tests/e2e/dogfooding-pipeline.test.ts` spawns the
 * real CLI against the repo's own Cloud-installed Genes. One `npm test` by a
 * signed-in developer wrote four rows into production `gene_invocation_log` —
 * source-linker twice, grammar-checker twice, two seconds apart.
 *
 * They were real executions but not real usage, and §33.4 exists to count
 * callers who actually reached for a Gene. A metrics pipeline that manufactures
 * its own traffic is broken in the opposite direction from the bug this module
 * was written to fix, and just as quietly.
 */
describe("runningUnderTest", () => {
  const savedEnv = { ...process.env };
  const dirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    delete process.env.ROTIFER_TELEMETRY;
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    loadCredentialsMock.mockReset();
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  function geneDir(): string {
    const dir = makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" });
    dirs.push(join(dir, "..", ".."));
    return dir;
  }

  it.each([
    ["VITEST", "true"],
    ["JEST_WORKER_ID", "1"],
    ["NODE_ENV", "test"],
  ])("reports nothing when %s is set — a test run is not usage", async (key, value) => {
    process.env[key] = value;
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");
    const report = recordGeneInvocation(geneDir());
    expect(report.reported).toBeNull();
    expect(report.reason).toBe("test-run");
    expect(report.settled).toBeUndefined();
  });

  it("still reports outside a test runner", async () => {
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");
    expect(recordGeneInvocation(geneDir()).reported).toBe(CLOUD_ID);
  });

  it("does not suppress on CI alone — a Gene called from a pipeline is still a caller", async () => {
    process.env.CI = "true";
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");
    expect(recordGeneInvocation(geneDir()).reported).toBe(CLOUD_ID);
  });

  it("NODE_ENV=production is not a test run", async () => {
    process.env.NODE_ENV = "production";
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");
    expect(recordGeneInvocation(geneDir()).reported).toBe(CLOUD_ID);
  });
});

/**
 * Channel attribution (migration 20260830000000).
 *
 * The ledger recorded that a call happened but not what it came through, so
 * "is anyone using this, and from where" was unanswerable — the question the
 * channel exists to answer now that Genes are reachable from five hosts.
 *
 * The CLI is the interesting reporter here because it is not always the entry
 * point: the MCP server shells out to it rather than executing Genes itself,
 * so a run that is really an MCP call would otherwise be filed as `cli`. The
 * parent declares the channel; this suite pins down what the CLI does with
 * that declaration, including when it is junk.
 */
describe("resolveInvocationChannel", () => {
  it("says cli when nothing declares otherwise — the common, honest case", async () => {
    const { resolveInvocationChannel } = await import("../../src/cloud/invocation.js");
    expect(resolveInvocationChannel({})).toBe("cli");
  });

  it("takes the parent's declaration when the CLI was spawned by another host", async () => {
    const { resolveInvocationChannel } = await import("../../src/cloud/invocation.js");
    expect(resolveInvocationChannel({ ROTIFER_INVOCATION_CHANNEL: "mcp:dsh" })).toBe("mcp:dsh");
  });

  it("treats an empty or whitespace declaration as absent, not as junk", async () => {
    const { resolveInvocationChannel } = await import("../../src/cloud/invocation.js");
    expect(resolveInvocationChannel({ ROTIFER_INVOCATION_CHANNEL: "" })).toBe("cli");
    expect(resolveInvocationChannel({ ROTIFER_INVOCATION_CHANNEL: "   " })).toBe("cli");
  });

  it.each([
    ["MCP:DSH", "uppercase would split one host across two rows in every aggregate"],
    ["Claude Code v1.2", "free text is not a groupable identifier"],
    ["mcp:dsh:extra", "only one qualifier is allowed"],
    ["mcp-dsh", "hyphens are outside the column's shape"],
    ["x".repeat(80), "over the column's length bound"],
  ])("drops a malformed declaration (%j) rather than sanitising it", async (value) => {
    const { resolveInvocationChannel } = await import("../../src/cloud/invocation.js");
    // Null, not a best-effort rewrite: turning "Claude Code" into "claude_code"
    // would invent an attribution the caller never made.
    expect(resolveInvocationChannel({ ROTIFER_INVOCATION_CHANNEL: value })).toBeNull();
  });

  it("accepts exactly what the database CHECK accepts", async () => {
    const { resolveInvocationChannel } = await import("../../src/cloud/invocation.js");
    // The regex is duplicated in the migration on purpose; if these two ever
    // disagree the report fails server-side and, being fire-and-forget, does
    // so silently. This is the assertion that notices.
    for (const ok of ["cli", "mcp", "mcp:dsh", "mcp:claude_code", "a", "a1_b:c2_d"]) {
      expect(resolveInvocationChannel({ ROTIFER_INVOCATION_CHANNEL: ok })).toBe(ok);
    }
  });
});

describe("recordGeneInvocation — which RPC it calls", () => {
  const savedEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  const dirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    delete process.env.ROTIFER_TELEMETRY;
    delete process.env.ROTIFER_INVOCATION_CHANNEL;
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    loadCredentialsMock.mockReset();
    loadCredentialsMock.mockReturnValue({ access_token: "tok", user: { id: USER_ID } });
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

  it("sends the channel through v2 when it has one", async () => {
    process.env.ROTIFER_INVOCATION_CHANNEL = "mcp:dsh";
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    const out = recordGeneInvocation(geneDir);

    expect(out.channel).toBe("mcp:dsh");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/rpc\/log_gene_invocation_v2$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      p_gene_id: CLOUD_ID,
      p_caller_agent_id: USER_ID,
      p_client_channel: "mcp:dsh",
    });
  });

  it("still calls v2 for a plain CLI run — cli is a channel, not an absence", async () => {
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    const out = recordGeneInvocation(geneDir);

    expect(out.channel).toBe("cli");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/rpc\/log_gene_invocation_v2$/);
    expect(JSON.parse(String(init?.body)).p_client_channel).toBe("cli");
  });

  it("falls back to the original RPC when the channel is unattributable", async () => {
    process.env.ROTIFER_INVOCATION_CHANNEL = "Not A Channel";
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    const out = recordGeneInvocation(geneDir);

    // The call is still reported. Losing the attribution must never cost us
    // the invocation itself — an unreported call is a hole in the ledger,
    // an unattributed one is just a NULL.
    expect(out.reported).toBe(CLOUD_ID);
    expect(out.channel).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/rpc\/log_gene_invocation$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      p_gene_id: CLOUD_ID,
      p_caller_agent_id: USER_ID,
    });
  });

  it("keeps every existing gate — a bad channel does not force a report through", async () => {
    process.env.ROTIFER_TELEMETRY = "0";
    process.env.ROTIFER_INVOCATION_CHANNEL = "mcp:dsh";
    const geneDir = trackDir(makeGeneDir({ cloud_id: CLOUD_ID, owner: "x", version: "0.1.0" }));
    const { recordGeneInvocation } = await import("../../src/cloud/invocation.js");

    expect(recordGeneInvocation(geneDir)).toEqual({ reported: null, reason: "telemetry-off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
