import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * When Rotifer Cloud can't be reached, the CLI has to say why. Node's fetch
 * reports every network failure as a bare "fetch failed" and keeps the real
 * cause (ECONNREFUSED, a reset, a DNS failure) in `err.cause`; the CLI used
 * to print only the bare message, so `rotifer versions` / `search` /
 * `reputation` answered an outage with "✗ fetch failed" and nothing a user
 * could act on. These cases run the real CLI against a cloud that refuses
 * the connection, drops it, or answers with an error status.
 */

const CLI = join(__dirname, "../../dist/index.js");
const HOME = join(tmpdir(), `rotifer-cloud-errors-${Date.now()}`);

let refusedEndpoint = "";
let dropServer: TcpServer;
let dropEndpoint = "";
let statusServer: Server;
let statusEndpoint = "";

function run(args: string[], endpoint: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [CLI, ...args],
      {
        cwd: HOME,
        timeout: 30_000,
        env: {
          ...process.env,
          HOME,
          NO_COLOR: "1",
          ROTIFER_TELEMETRY: "0",
          ROTIFER_NO_UPDATE_CHECK: "1",
          ROTIFER_CLOUD_ENDPOINT: endpoint,
        },
      },
      (_err, stdout, stderr) => resolve({ out: `${stdout}${stderr}`, code: child.exitCode }),
    );
  });
}

beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });

  // A port nothing listens on: bind, note it, close.
  const probe = createTcpServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const refusedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  refusedEndpoint = `http://127.0.0.1:${refusedPort}`;

  // Accepts the connection, then drops it before any response.
  dropServer = createTcpServer((socket) => socket.destroy());
  await new Promise<void>((r) => dropServer.listen(0, "127.0.0.1", r));
  dropEndpoint = `http://127.0.0.1:${(dropServer.address() as AddressInfo).port}`;

  // Answers like PostgREST does when the database is unavailable.
  statusServer = createServer((_req, res) => {
    res
      .writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ message: "Service temporarily unavailable" }));
  });
  await new Promise<void>((r) => statusServer.listen(0, "127.0.0.1", r));
  statusEndpoint = `http://127.0.0.1:${(statusServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => dropServer.close(() => r()));
  await new Promise<void>((r) => statusServer.close(() => r()));
  rmSync(HOME, { recursive: true, force: true });
});

describe("Rotifer Cloud failures name their cause", () => {
  it("versions: a refused connection names the cloud and ECONNREFUSED", async () => {
    const { out, code } = await run(["versions", "@nobody/some-gene"], refusedEndpoint);
    expect(code).toBe(1);
    expect(out).toContain(`Cannot reach Rotifer Cloud (${refusedEndpoint})`);
    expect(out).toContain("connection refused (ECONNREFUSED)");
    expect(out).not.toMatch(/^✗ fetch failed$/m);
    // An outage is not a typo in the gene name.
    expect(out).not.toContain("Check the gene name/ID");
    expect(out).toContain("retry when Rotifer Cloud is reachable");
  });

  it("versions: a dropped connection says it closed before answering", async () => {
    const { out, code } = await run(["versions", "@nobody/some-gene"], dropEndpoint);
    expect(code).toBe(1);
    expect(out).toContain(`Cannot reach Rotifer Cloud (${dropEndpoint})`);
    expect(out).toMatch(/connection (closed before a response|reset) \((UND_ERR_SOCKET|ECONNRESET)\)/);
  });

  it("search: the same cause, from a different registry call", async () => {
    const { out, code } = await run(["search", "anything"], refusedEndpoint);
    expect(code).toBe(1);
    expect(out).toContain(`Cannot reach Rotifer Cloud (${refusedEndpoint})`);
    expect(out).toContain("ECONNREFUSED");
  });

  it("reputation --leaderboard: the same cause, from an RPC call", async () => {
    const { out, code } = await run(["reputation", "--leaderboard"], refusedEndpoint);
    expect(code).toBe(1);
    expect(out).toContain(`Cannot reach Rotifer Cloud (${refusedEndpoint})`);
    expect(out).toContain("ECONNREFUSED");
  });

  it("an error status keeps the status and the cloud's own message", async () => {
    const { out, code } = await run(["versions", "@nobody/some-gene"], statusEndpoint);
    expect(code).toBe(1);
    expect(out).toContain("Cloud API error (503): Service temporarily unavailable");
  });
});
