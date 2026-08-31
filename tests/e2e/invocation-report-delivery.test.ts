import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FLUSH_TIMEOUT_MS } from "../../src/cloud/invocation.js";
import { isNativeAvailable } from "../../src/utils/binding.js";

/**
 * A Cloud-installed gene (has .cloud-manifest.json) run with --trust-unsigned
 * needs the native addon: without it, l0-gate.ts refuses to run an
 * externally-sourced gene at all — "native addon failed to load" — by design,
 * the strict/safe direction (see l0-gate.ts's own comment on that refusal).
 * This is not hypothetical here: this repo's own release-please branch omits
 * the platform packages from package-lock.json until the tag they are
 * published from exists (release.yml's sync-lock job; see
 * project_playground_release_lock_window.md-class incidents), so `npm ci` on
 * a Release PR genuinely has no native addon to load — confirmed by hand,
 * 2026-08-31: same lockfile, same build, `rotifer run` on a Cloud-installed
 * gene refuses with exactly that message, output otherwise empty. Every
 * other native-addon-dependent suite in this repo already skips on this
 * condition (tests/e2e/dogfooding-pipeline.test.ts's skipRuntime); this file
 * predates knowing it needed the same guard.
 */
const hasNativeAddon = isNativeAvailable();

/**
 * Black-box regression for the signed-in invocation report — the ledger
 * behind the §33.4 anti-manipulation metrics, and the sibling signal to
 * tests/e2e/telemetry-heartbeat-delivery.test.ts's anonymous heartbeat.
 * Same file (cloud/invocation.ts), same fetch shape, same FLUSH_TIMEOUT_MS,
 * same AbortController fix from the fixes in this file's companion — but
 * until now, never actually exercised end to end. Every E2E and manual
 * production check run this session (cursor-agent included) ran signed
 * out, against locally-authored Genes, so recordGeneInvocation() always
 * short-circuited on `not-logged-in` or `no-cloud-identity` before it ever
 * reached the network. This closes that gap — pointed out directly by the
 * user after noticing the admin dashboard's "登录调用账本" (invocation
 * ledger) card showed zero, which turned out to be an unrelated pipeline
 * issue downstream, not a delivery problem, but the fact remained: this
 * signal had never actually been tested.
 *
 * recordGeneInvocation() requires two things neither of the other suites
 * set up: a signed-in credentials file and a Cloud-installed Gene (one
 * with a .cloud-manifest.json). Neither requires a real OAuth flow — both
 * are just files loadCredentials()/cloudGeneId() read from disk, so they
 * are faked here the same way the rest of this repo's E2E suites fake
 * ~/.rotifer state, not by driving a browser.
 *
 * Mirrors telemetry-heartbeat-delivery.test.ts's structure and the same
 * three lessons documented there in detail (loopback's "did it eventually
 * arrive" and "wall-clock time" both fail to distinguish a flushed request
 * from a dropped one — only a genuinely-unresponsive endpoint plus a hard
 * timeout does): a responding fake server for the ordinary-delivery case,
 * and a never-responding one for the "does it give up on schedule instead
 * of hanging forever" case.
 */

const CLI = join(__dirname, "..", "..", "dist", "index.js");

const CLOUD_ID = "a3f8c1e2-4b9d-4e7a-8c3f-1d9e6b2a5f70";
const USER_ID = "3fcaab49-3b61-4e75-9268-5bf90394b947";

interface RecordedRequest {
  path: string;
  body: unknown;
  authorization: string | undefined;
}

function startRespondingCloud(): { server: Server; url: string; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null");
      } catch {
        /* not JSON */
      }
      requests.push({ path: req.url || "", body, authorization: req.headers.authorization });
      res.writeHead(204);
      res.end();
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

function startHangingCloud(): { server: Server; url: string; requestsSeen: { count: number } } {
  const requestsSeen = { count: 0 };
  const server = createServer((req) => {
    req.on("data", () => {});
    req.on("end", () => {
      requestsSeen.count++;
      // No res.end() — ever. See telemetry-heartbeat-delivery.test.ts's top
      // comment for why this, and not a delayed-response, is the shape
      // that actually distinguishes a flushed+aborted request from a
      // dropped one on loopback.
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-invocation-e2e-" + randomUUID());
  mkdirSync(join(dir, "genes"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({ name: "invocation-e2e", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
  );
  return dir;
}

/** A Cloud-installed Gene: same shape as `rotifer install` leaves on disk — a .cloud-manifest.json is what cloudGeneId() requires to attribute an invocation at all. */
function writeCloudInstalledGene(projectDir: string, name: string, source: string): void {
  const geneDir = join(projectDir, "genes", name);
  mkdirSync(geneDir, { recursive: true });
  writeFileSync(
    join(geneDir, "phenotype.json"),
    JSON.stringify({ domain: "general", inputSchema: { type: "object" }, outputSchema: { type: "object" }, version: "0.1.0", fidelity: "Wrapped" }, null, 2),
  );
  writeFileSync(join(geneDir, "index.ts"), source);
  writeFileSync(
    join(geneDir, ".cloud-manifest.json"),
    JSON.stringify({ cloud_id: CLOUD_ID, owner: "e2e-test-owner", version: "0.1.0" }, null, 2),
  );
}

// Good enough for this file's fixed, quote-free-except-json arg strings —
// not a general shell-arg parser. (Mirrors
// telemetry-heartbeat-delivery.test.ts's helper of the same name.)
function splitArgs(args: string): string[] {
  return args.match(/'[^']*'|\S+/g)?.map((a) => a.replace(/^'|'$/g, "")) ?? [];
}

/** What `rotifer login` leaves in ~/.rotifer/credentials.json — loadCredentials() just reads and JSON.parses this file, no OAuth involved. */
function writeSignedInCredentials(fakeHome: string): void {
  mkdirSync(join(fakeHome, ".rotifer"), { recursive: true });
  writeFileSync(
    join(fakeHome, ".rotifer", "credentials.json"),
    JSON.stringify({
      access_token: "e2e-test-access-token",
      refresh_token: "e2e-test-refresh-token",
      expires_at: Date.now() + 3600_000,
      provider: "github",
      user: { id: USER_ID, username: "e2e-tester", avatar_url: null, provider_id: "12345" },
    }),
  );
}

describe("signed-in invocation report — real CLI process, real network, never exercised until now", () => {
  let projectDir: string;
  let fakeHome: string;

  beforeEach(() => {
    projectDir = makeProject();
    fakeHome = mkdtempSync(join(tmpdir(), "rotifer-invocation-e2e-home-"));
    writeSignedInCredentials(fakeHome);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function runCli(
    args: string,
    endpoint: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ exitCode: number | null; killedByTestTimeout: boolean; output: string; durationMs: number }> {
    // Same env stripping as telemetry-heartbeat-delivery.test.ts —
    // runningUnderTest() must see none of vitest's own markers, since this
    // suite is specifically exercising the production path.
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
          ROTIFER_CLOUD_ENDPOINT: endpoint,
          ROTIFER_CLOUD_ANON_KEY: "test-anon-key",
          ROTIFER_TELEMETRY: "1",
          DO_NOT_TRACK: "",
          ROTIFER_NO_UPDATE_CHECK: "1",
          ...extraEnv,
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

  describe("ordinary delivery", () => {
    let respondingCloud: ReturnType<typeof startRespondingCloud>;

    beforeAll(() => {
      respondingCloud = startRespondingCloud();
    });

    afterAll(() => {
      respondingCloud.server.close();
    });

    beforeEach(() => {
      respondingCloud.requests.length = 0;
    });

    it.skipIf(!hasNativeAddon)("`rotifer run` on a Cloud-installed gene reports the invocation with the signed-in user's identity and Bearer token", async () => {
      writeCloudInstalledGene(projectDir, "ir-gene", "export function express(input) { return { ok: true, ...input }; }\n");

      // --trust-unsigned: a Cloud-installed gene (has .cloud-manifest.json)
      // that isn't compiled to WASM refuses to run via the unsandboxed
      // Node.js fallback without it (l0-gate.ts's isExternallySourced) —
      // unrelated to what this test verifies, just what makes an
      // uncompiled fixture gene runnable at all.
      const { exitCode, output, durationMs } = await runCli("run ir-gene --input '{}' --trust-unsigned", respondingCloud.url);

      expect(exitCode, `CLI output:\n${output}`).toBe(0);
      // Well under FLUSH_TIMEOUT_MS — a responding endpoint should not need
      // to burn the full timeout budget, unlike the hanging-endpoint case
      // below.
      expect(durationMs).toBeLessThan(FLUSH_TIMEOUT_MS);

      const reports = respondingCloud.requests.filter((r) => r.path.includes("log_gene_invocation"));
      expect(reports, `CLI output:\n${output}`).toHaveLength(1);
      expect(reports[0].path).toContain("log_gene_invocation_v2"); // channel is attributable ("cli"), so v2
      expect(reports[0].authorization).toBe("Bearer e2e-test-access-token");
      expect((reports[0].body as any).p_gene_id).toBe(CLOUD_ID);
      expect((reports[0].body as any).p_caller_agent_id).toBe(USER_ID);
      expect((reports[0].body as any).p_client_channel).toBe("cli");
    });

    it("a locally-authored gene (no .cloud-manifest.json) reports nothing — signed in is not enough on its own", async () => {
      mkdirSync(join(projectDir, "genes", "local-gene"), { recursive: true });
      writeFileSync(
        join(projectDir, "genes", "local-gene", "phenotype.json"),
        JSON.stringify({ domain: "general", inputSchema: { type: "object" }, outputSchema: { type: "object" }, version: "0.1.0", fidelity: "Wrapped" }),
      );
      writeFileSync(join(projectDir, "genes", "local-gene", "index.ts"), "export function express(input) { return { ok: true, ...input }; }\n");

      const { exitCode } = await runCli("run local-gene --input '{}'", respondingCloud.url);

      expect(exitCode).toBe(0);
      expect(respondingCloud.requests.filter((r) => r.path.includes("log_gene_invocation"))).toHaveLength(0);
    });

    it.skipIf(!hasNativeAddon)("the failure path — process.exit(1) — still reports the invocation before the process ends", async () => {
      writeCloudInstalledGene(projectDir, "ir-fail-gene", "export function express() { throw new Error('boom'); }\n");

      const { exitCode, output } = await runCli("run ir-fail-gene --input '{}' --trust-unsigned", respondingCloud.url);

      expect(exitCode, `CLI output:\n${output}`).toBe(1);
      const reports = respondingCloud.requests.filter((r) => r.path.includes("log_gene_invocation"));
      expect(reports, `CLI output:\n${output}`).toHaveLength(1);
    });
  });

  /**
   * The one thing ordinary delivery cannot show: whether a stalled endpoint
   * hangs the process past FLUSH_TIMEOUT_MS. Mirrors
   * telemetry-heartbeat-delivery.test.ts's hanging-cloud cases exactly —
   * same reasoning for why the fake server never responds, same reasoning
   * for why wall-clock time (not "did it arrive") is the assertion that
   * actually distinguishes the fixed code from the unfixed.
   */
  it.skipIf(!hasNativeAddon)("a stalled invocation-report endpoint does not hang the process past FLUSH_TIMEOUT_MS", async () => {
    const hangingCloud = startHangingCloud();
    try {
      writeCloudInstalledGene(projectDir, "ir-hang-gene", "export function express(input) { return { ok: true, ...input }; }\n");

      const { exitCode, killedByTestTimeout, output, durationMs } = await runCli("run ir-hang-gene --input '{}' --trust-unsigned", hangingCloud.url);

      expect(killedByTestTimeout, `CLI output:\n${output}`).toBe(false);
      expect(exitCode, `CLI output:\n${output}`).toBe(0);
      expect(durationMs).toBeGreaterThanOrEqual(FLUSH_TIMEOUT_MS - 200);
      expect(durationMs).toBeLessThan(FLUSH_TIMEOUT_MS + 5000);
    } finally {
      hangingCloud.server.close();
    }
  }, 20000);
});
