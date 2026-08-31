import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * recordHeartbeat() end to end through the fake network boundary. Real
 * production behaviour (RPC actually reachable, upsert semantics, RLS) was
 * verified separately against the live database (ADR-329 D4-style check,
 * not repeated here) — this file is about the client-side contract: which
 * URL, which body, when the notice prints, and that every failure mode is
 * silence.
 */
describe("recordHeartbeat", () => {
  let testHome: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "rotifer-heartbeat-"));
    process.env.HOME = testHome;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    delete process.env.ROTIFER_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    delete process.env.ROTIFER_INVOCATION_CHANNEL;
    // recordHeartbeat refuses to report under a test runner by design (same
    // guard as recordGeneInvocation) — these tests exercise the real path,
    // so the markers it looks for have to go, same as cloud-invocation.test.ts.
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(testHome, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("posts to record_heartbeat with the machine's id, cli channel, version, and delta 1", async () => {
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");
    const { loadOrInitHeartbeatConfig } = await import("../../src/telemetry/config.js");
    const config = loadOrInitHeartbeatConfig();

    recordHeartbeat();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloud.example.test/rest/v1/rpc/record_heartbeat");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.apikey).toBe("anon-test-key");
    // No Authorization header — record_heartbeat is anon-callable by design,
    // and sending one here would defeat the "no identity required" promise.
    expect(init?.headers?.Authorization).toBeUndefined();

    const body = JSON.parse(String(init?.body));
    expect(body.p_machine_id).toBe(config.machine_id);
    expect(body.p_channel).toBe("cli");
    expect(body.p_invocation_delta).toBe(1);
    expect(typeof body.p_client_version === "string" || body.p_client_version === null).toBe(true);
  });

  it("uses the declared channel when the CLI was spawned by MCP", async () => {
    process.env.ROTIFER_INVOCATION_CHANNEL = "mcp:dsh";
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    recordHeartbeat();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.p_channel).toBe("mcp:dsh");
  });

  it("prints the first-run notice to stderr exactly once, and only when a report actually sends", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    recordHeartbeat();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const noticeCalls = stderrSpy.mock.calls.filter((c) => String(c[0]).includes("Anonymous usage heartbeat"));
    expect(noticeCalls).toHaveLength(1);

    recordHeartbeat();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const noticeCallsAfterSecond = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Anonymous usage heartbeat"),
    );
    expect(noticeCallsAfterSecond).toHaveLength(1); // still just the one

    stderrSpy.mockRestore();
  });

  it("sends nothing when ROTIFER_TELEMETRY=0 — and prints no notice either", async () => {
    process.env.ROTIFER_TELEMETRY = "0";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    recordHeartbeat();
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).not.toHaveBeenCalled();
    // A user who opted out should never see "we're about to collect data"
    // for data that in fact never leaves the machine.
    const noticeCalls = stderrSpy.mock.calls.filter((c) => String(c[0]).includes("Anonymous usage heartbeat"));
    expect(noticeCalls).toHaveLength(0);
    stderrSpy.mockRestore();
  });

  it("sends nothing when DO_NOT_TRACK=1, even if ROTIFER_TELEMETRY=1", async () => {
    process.env.DO_NOT_TRACK = "1";
    process.env.ROTIFER_TELEMETRY = "1";
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    recordHeartbeat();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects a stored 'off' choice with no env override", async () => {
    const { setHeartbeatEnabled } = await import("../../src/telemetry/config.js");
    setHeartbeatEnabled(false);
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    recordHeartbeat();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    expect(() => recordHeartbeat()).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("never throws when ~/.rotifer can't be created", async () => {
    // HOME points at a plain *file*, not a directory — ensurePrivateDir's
    // mkdirSync(..., {recursive:true}) for anything under it fails
    // structurally (ENOTDIR). Deliberately not a chmod-based permission
    // test: that depends on the runner not being root, which CI sometimes
    // is, and would silently pass instead of testing anything. This failure
    // mode doesn't depend on who's running the test.
    const { writeFileSync: write } = await import("node:fs");
    const blockerFile = join(tmpdir(), "rotifer-heartbeat-blocker-" + Date.now());
    write(blockerFile, "not a directory");
    process.env.HOME = blockerFile;
    vi.resetModules();

    const { recordHeartbeat } = await import("../../src/telemetry/heartbeat.js");
    expect(() => recordHeartbeat()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled(); // never got past config init

    rmSync(blockerFile);
  });
});

/**
 * Regression for a real end-to-end run against production (2026-08-30):
 * `rotifer run` on a freshly-provisioned machine printed the first-run
 * notice (proof recordHeartbeat() reached the fetch) and exited 0, but
 * usage_heartbeat_public never showed the row. A manual POST with the same
 * body against the same machine_id landed immediately, which rules out the
 * RPC, the grant, and the endpoint — the only variable was that the CLI
 * process existed a few hundred milliseconds longer. The theory this file
 * used to rely on — "Node drains the pending request before the event loop
 * empties" — does not hold for this fetch. flushHeartbeat() exists so a
 * caller can wait for the request to actually leave before letting the
 * process end, exactly like flushInvocationReports() for the signed-in
 * report.
 */
describe("flushHeartbeat", () => {
  let testHome: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "rotifer-heartbeat-flush-"));
    process.env.HOME = testHome;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    delete process.env.ROTIFER_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    delete process.env.ROTIFER_INVOCATION_CHANNEL;
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(testHome, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("resolves immediately when nothing is in flight", async () => {
    const { flushHeartbeat } = await import("../../src/telemetry/heartbeat.js");
    await expect(flushHeartbeat(50)).resolves.toBeUndefined();
  });

  it("waits for an in-flight heartbeat to settle — this is exactly what production was missing", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const { recordHeartbeat, flushHeartbeat } = await import("../../src/telemetry/heartbeat.js");

    recordHeartbeat();

    let flushed = false;
    const flushing = flushHeartbeat(5000).then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false); // still pending — a bare process.exit()/return here is the bug

    release(new Response(null, { status: 204 }));
    await flushing;
    expect(flushed).toBe(true);
  });

  it("gives up after the timeout rather than hanging the run", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => { /* never settles */ })));
    const { recordHeartbeat, flushHeartbeat } = await import("../../src/telemetry/heartbeat.js");
    recordHeartbeat();
    await expect(flushHeartbeat(30)).resolves.toBeUndefined();
  });

  it("stops tracking a heartbeat once it settles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const { recordHeartbeat, flushHeartbeat } = await import("../../src/telemetry/heartbeat.js");
    recordHeartbeat();
    await flushHeartbeat(5000);
    // Nothing left to wait for: a zero timeout still resolves.
    await expect(flushHeartbeat(0)).resolves.toBeUndefined();
  });

  it("has nothing to flush when a gate blocked the report before any fetch", async () => {
    process.env.ROTIFER_TELEMETRY = "0";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const { recordHeartbeat, flushHeartbeat } = await import("../../src/telemetry/heartbeat.js");
    recordHeartbeat();
    await expect(flushHeartbeat(0)).resolves.toBeUndefined();
  });
});
