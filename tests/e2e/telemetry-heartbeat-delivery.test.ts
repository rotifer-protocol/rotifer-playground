import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FLUSH_TIMEOUT_MS } from "../../src/telemetry/heartbeat.js";

/**
 * Black-box regression for the 2026-08-30 production finding: `rotifer run`
 * printed the heartbeat first-run notice and exited 0, but the row never
 * reached the database. Every layer below this one already had unit
 * coverage before that finding — heartbeat.ts's own contract
 * (tests/unit/telemetry-heartbeat.test.ts), and each command's individual
 * flush call sites (code review). Neither would have caught the actual bug:
 * the bug was never "does flushHeartbeat() work in isolation" or "is this
 * call site wired up" — it was "does this real CLI process, end to end,
 * actually deliver the request before it exits". Only spawning the real
 * built CLI and observing it from outside can answer that.
 *
 * The fake server here never responds — no res.end(), ever. Getting here
 * took three designs, and the failures of the first two are worth keeping
 * because they found a second, worse bug this file's assertions now guard
 * against too:
 *
 * v1 delayed the *response* by a fixed amount and checked whether the
 * server eventually saw the request. It passed with every flushHeartbeat()
 * call site ripped out of run.ts, because on loopback HTTP a written
 * request is already in the kernel's send buffer microseconds after the
 * client calls fetch() — the OS keeps delivering it regardless of whether
 * the writing process is still alive, so "did it eventually arrive" cannot
 * tell a flushed request from a dropped one here the way it demonstrably
 * could against a real network in production (DNS + TLS handshake, both
 * absent from 127.0.0.1, are exactly the window a short CLI process can
 * exit inside of).
 *
 * v2 asserted wall-clock time against a delayed-but-eventual response
 * instead, on the theory that a process genuinely awaiting a response
 * cannot exit before it arrives. That also passed with every
 * flushHeartbeat() call site removed — because on loopback, an
 * *un-awaited* fetch's underlying open socket is still an active libuv
 * handle, and Node does not exit while an active handle exists whether or
 * not anything in userland is awaiting it.
 *
 * v3 (this file) makes the fake server hang forever instead of eventually
 * responding, to find out what happens when that open handle never
 * settles on its own — and it does not resolve on a timer either: it hung
 * every case until this suite's own 15s kill, *even with flushHeartbeat()
 * correctly wired into every call site*. flushHeartbeat() giving up after
 * FLUSH_TIMEOUT_MS only stops the caller from waiting; it was never
 * cancelling the fetch underneath. A stalled telemetry endpoint would have
 * hung every `rotifer run` for as long as the OS's own TCP timeout takes —
 * worse than the original bug, which just dropped a data point. Fixed by
 * adding an AbortController to the fetch in both heartbeat.ts and
 * cloud/invocation.ts (identical fetch shape, same gap), aborting on the
 * same FLUSH_TIMEOUT_MS deadline. See the matching unit tests
 * ("aborts the underlying fetch after FLUSH_TIMEOUT_MS") for that in
 * isolation.
 *
 * One consequence worth being honest about: because the abort now lives
 * inside recordHeartbeat() itself, it fires whether or not a call site
 * remembers flushHeartbeat() — so on a *hung* request specifically, the
 * three success-path assertions below (near-FLUSH_TIMEOUT_MS, clean exit)
 * no longer distinguish "flushHeartbeat() was called" from "it wasn't but
 * the request stalled anyway", the way they did against v2's
 * eventually-responds fixture. What they still prove, and prove more
 * strongly than before: a stalled endpoint can no longer hang the CLI
 * indefinitely, on any of these three paths. The one case here that still
 * pins flushHeartbeat() itself is the failing-gene test: process.exit()
 * terminates immediately, gives the abort timer no chance to fire either,
 * and only an explicit `await flushHeartbeat()` before it can let the
 * request be reported (or cleanly abandoned) instead of killed mid-flight
 * — confirmed by hand, commenting out that one call site alone drops this
 * suite's failing-gene case to a ~180ms exit, well under LOWER_BOUND_MS.
 *
 * spawn(), not spawnSync(): spawnSync blocks this process's whole event
 * loop until the child exits, which means the fake server below — running
 * in this same process — could never accept the child's connection while
 * spawnSync was blocking on it. Confirmed by hand before writing this
 * file: a parent that starts an HTTP server and spawnSync's a child that
 * fetches it hangs until the child's own timeout kills it, every time,
 * with the server never even seeing the connection attempt. Async spawn()
 * lets this process's event loop keep running the server while the child
 * talks to it.
 */

const CLI = join(__dirname, "..", "..", "dist", "index.js");
// Generous headroom above FLUSH_TIMEOUT_MS for the CLI's own base
// startup+execution cost (measured by hand at ~320ms with telemetry off on
// this machine) plus scheduling noise — while staying well under this
// suite's own 15s kill, so a process that never gives up is unambiguously
// distinguishable from one that gave up on schedule.
const UPPER_BOUND_MS = FLUSH_TIMEOUT_MS + 5000;
const LOWER_BOUND_MS = FLUSH_TIMEOUT_MS - 200;

function startHangingCloud(): { server: Server; url: string; requestsSeen: { count: number } } {
  const requestsSeen = { count: 0 };
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      requestsSeen.count++;
      // No res.end() — ever. The request is fully received but never
      // answered, standing in for a request that stalls before a response
      // can come back (the DNS/TLS-handshake shape production actually
      // hit, indefinitely extended so the only thing that can end this
      // client-side is its own timeout).
      void res;
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, requestsSeen };
}

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-heartbeat-e2e-" + randomUUID());
  mkdirSync(join(dir, "genes"), { recursive: true });
  mkdirSync(join(dir, ".rotifer", "agents"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "heartbeat-e2e",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    }),
  );
  return dir;
}

function writeGene(dir: string, name: string, source: string): void {
  mkdirSync(join(dir, "genes", name), { recursive: true });
  writeFileSync(
    join(dir, "genes", name, "phenotype.json"),
    JSON.stringify(
      { domain: "general", inputSchema: { type: "object" }, outputSchema: { type: "object" }, version: "0.1.0", fidelity: "Wrapped" },
      null,
      2,
    ),
  );
  // rotifer run only looks for index.ts (agent-run's findSourceFile also
  // accepts .js/.mjs, but .ts works for both commands, so both tests below
  // share this one helper).
  writeFileSync(join(dir, "genes", name, "index.ts"), source);
}

function writeAgent(dir: string, name: string, genome: string[], composition = "Seq"): void {
  writeFileSync(
    join(dir, ".rotifer", "agents", randomUUID() + ".json"),
    JSON.stringify(
      { id: randomUUID(), name, state: "Active", genome, composition, strategy: "manual", createdAt: new Date().toISOString(), reputation: 0 },
      null,
      2,
    ),
  );
}

// Good enough for this file's fixed, quote-free arg strings — not a general
// shell-arg parser.
function splitArgs(args: string): string[] {
  return args.match(/'[^']*'|\S+/g)?.map((a) => a.replace(/^'|'$/g, "")) ?? [];
}

describe("heartbeat gives up on a stalled request instead of hanging the process forever", () => {
  let hangingCloud: ReturnType<typeof startHangingCloud>;
  let projectDir: string;
  let fakeHome: string;

  beforeAll(() => {
    hangingCloud = startHangingCloud();
  });

  afterAll(() => {
    hangingCloud.server.close();
  });

  beforeEach(() => {
    projectDir = makeProject();
    fakeHome = mkdtempSync(join(tmpdir(), "rotifer-heartbeat-e2e-home-"));
    hangingCloud.requestsSeen.count = 0;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function runCli(args: string): Promise<{ exitCode: number | null; killedByTestTimeout: boolean; output: string; durationMs: number }> {
    // recordHeartbeat()/recordGeneInvocation() both refuse to report under a
    // test runner (runningUnderTest() in cloud/invocation.ts) — and vitest's
    // own process passes VITEST=true down to any child it spawns unless a
    // caller strips it. Every other value is inherited from the parent
    // (PATH, etc.) except these three, which must not survive into the
    // child: this suite is specifically testing the production path.
    const env = { ...process.env };
    delete env.VITEST;
    delete env.JEST_WORKER_ID;
    delete env.NODE_ENV;

    return new Promise((resolve, reject) => {
      const start = Date.now();
      const child = spawn("node", [CLI, ...splitArgs(args)], {
        cwd: projectDir,
        env: {
          ...env,
          HOME: fakeHome,
          FORCE_COLOR: "0",
          ROTIFER_CLOUD_ENDPOINT: hangingCloud.url,
          ROTIFER_CLOUD_ANON_KEY: "test-anon-key",
          ROTIFER_TELEMETRY: "1",
          DO_NOT_TRACK: "",
          // Unrelated to the heartbeat, but real: index.ts's own
          // update-check hits registry.npmjs.org and, in a
          // network-restricted sandbox, can stall — irrelevant to what
          // this suite tests, so keep it out of the way.
          ROTIFER_NO_UPDATE_CHECK: "1",
        },
      });
      let output = "";
      child.stdout.on("data", (d) => { output += d; });
      child.stderr.on("data", (d) => { output += d; });
      let killedByTestTimeout = false;
      const timer = setTimeout(() => {
        killedByTestTimeout = true;
        child.kill("SIGKILL");
      }, 15000);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, killedByTestTimeout, output, durationMs: Date.now() - start });
      });
    });
  }

  it("`rotifer run` on a successful gene — the exact shape that dropped the heartbeat in production", async () => {
    writeGene(projectDir, "hb-gene", "export function express(input) { return { ok: true, ...input }; }\n");

    const { exitCode, killedByTestTimeout, output, durationMs } = await runCli("run hb-gene --input '{}'");

    // See this file's top comment for what these prove and don't: with the
    // abort wired into recordHeartbeat() itself, a stalled endpoint can no
    // longer hang this process past FLUSH_TIMEOUT_MS — but on this
    // success path that guarantee no longer isolates flushHeartbeat()
    // specifically. The failing-gene case below is what still does.
    expect(killedByTestTimeout).toBe(false);
    expect(exitCode).toBe(0);
    expect(durationMs).toBeGreaterThanOrEqual(LOWER_BOUND_MS);
    expect(durationMs).toBeLessThan(UPPER_BOUND_MS);
    expect(output).toContain("Anonymous usage heartbeat is on by default");
    expect(hangingCloud.requestsSeen.count).toBe(1);
  }, 20000);

  it("`rotifer agent run` (Seq) on an all-success pipeline — the fall-through success path in agent-run.ts", async () => {
    writeGene(projectDir, "step-one", "export function express(input) { return { step: 1, ...input }; }\n");
    writeGene(projectDir, "step-two", "export function express(input) { return { step: 2, ...input }; }\n");
    writeAgent(projectDir, "hb-agent", ["step-one", "step-two"], "Seq");

    const { exitCode, killedByTestTimeout, durationMs } = await runCli("agent run hb-agent --input '{}'");

    expect(killedByTestTimeout).toBe(false);
    expect(exitCode).toBe(0);
    expect(durationMs).toBeGreaterThanOrEqual(LOWER_BOUND_MS);
    expect(durationMs).toBeLessThan(UPPER_BOUND_MS);
  }, 20000);

  it("`rotifer agent run` (TryPool) — the other success path that used to fall through with no flush at all", async () => {
    writeGene(projectDir, "try-gene", "export function express(input) { return { pool: true, ...input }; }\n");
    writeAgent(projectDir, "hb-trypool-agent", ["try-gene"], "TryPool");

    const { exitCode, killedByTestTimeout, durationMs } = await runCli("agent run hb-trypool-agent --input '{}'");

    expect(killedByTestTimeout).toBe(false);
    expect(exitCode).toBe(0);
    expect(durationMs).toBeGreaterThanOrEqual(LOWER_BOUND_MS);
    expect(durationMs).toBeLessThan(UPPER_BOUND_MS);
  }, 20000);

  it("`rotifer run` on a failing gene — the failure path that already flushed invocation reports but not the heartbeat", async () => {
    writeGene(projectDir, "hb-fail-gene", "export function express() { throw new Error('boom'); }\n");

    const { exitCode, killedByTestTimeout, durationMs } = await runCli("run hb-fail-gene --input '{}'");

    expect(killedByTestTimeout).toBe(false);
    expect(exitCode).toBe(1);
    expect(durationMs).toBeGreaterThanOrEqual(LOWER_BOUND_MS);
    expect(durationMs).toBeLessThan(UPPER_BOUND_MS);
  }, 20000);
});
