import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server, type AddressInfo } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRecordedCloud, type RecordedCloud } from "./recorded-cloud.js";

/**
 * "Check the gene name" is advice for one answer only: the registry said the
 * gene does not exist. `info`, `stats`, `compare`, `install` and
 * `reputation <gene>` gave it for every failure, so with Rotifer Cloud
 * unreachable they printed "✗ Cannot reach Rotifer Cloud (…): connection
 * refused (ECONNREFUSED)" and then sent the user to check a name that was
 * fine (seen in the live check's simulated outage, run 41301551270).
 *
 * Each command runs three times:
 * - against the recorded cloud with its port closed (connection refused);
 * - against the recorded cloud with a gene it does not have;
 * - against a cloud that answers 503.
 */

const CLI = join(__dirname, "../../dist/index.js");
const HOME = join(tmpdir(), `rotifer-cloud-offline-hints-${Date.now()}`);

const NAME_HINT = /Check the gene|rotifer search/;
const REACHABILITY_HINT = "Check your network connection, or retry when Rotifer Cloud is reachable.";

let cloud: RecordedCloud;
let refusedEndpoint = "";
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
  // A workspace, so `install` gets as far as the registry.
  mkdirSync(join(HOME, "genes"), { recursive: true });
  writeFileSync(
    join(HOME, "rotifer.json"),
    JSON.stringify({ name: "offline-hints", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
  );
  cloud = await startRecordedCloud();

  // The recorded cloud, stopped: its port now refuses the connection.
  const stopped = await startRecordedCloud();
  refusedEndpoint = stopped.endpoint;
  await stopped.close();

  statusServer = createServer((_req, res) => {
    res
      .writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ message: "Service temporarily unavailable" }));
  });
  await new Promise<void>((r) => statusServer.listen(0, "127.0.0.1", r));
  statusEndpoint = `http://127.0.0.1:${(statusServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Stop the server first, so a failed check cannot leave it running.
  const unrecorded = await cloud.unrecorded();
  await cloud.close();
  await new Promise<void>((r) => statusServer.close(() => r()));
  rmSync(HOME, { recursive: true, force: true });
  expect(unrecorded).toEqual([]);
});

/** The command, and a gene the recorded cloud does not have. */
const COMMANDS: Array<{ name: string; args: string[]; missing: string }> = [
  { name: "info", args: ["info", "no-such-gene-xyz"], missing: "no-such-gene-xyz" },
  { name: "stats", args: ["stats", "no-such-gene-xyz"], missing: "no-such-gene-xyz" },
  { name: "compare", args: ["compare", "no-such-gene-xyz", "grammar-checker"], missing: "no-such-gene-xyz" },
  { name: "install", args: ["install", "no-such-gene-xyz"], missing: "no-such-gene-xyz" },
  { name: "reputation <gene>", args: ["reputation", "no-such-gene-xyz"], missing: "no-such-gene-xyz" },
];

describe("with Rotifer Cloud unreachable, no command blames the gene name", () => {
  for (const { name, args } of [...COMMANDS, { name: "versions", args: ["versions", "@nobody/no-such-gene-xyz"] }]) {
    it(`${name}: names the cause and says to retry when the cloud is reachable`, async () => {
      const { out, code } = await run(args, refusedEndpoint);
      expect(code, out).toBe(1);
      expect(out).toContain(`Cannot reach Rotifer Cloud (${refusedEndpoint}): connection refused (ECONNREFUSED)`);
      expect(out).toContain(REACHABILITY_HINT);
      expect(out).not.toMatch(NAME_HINT);
    });
  }
});

describe("a gene the registry does not have still gets the name hint", () => {
  for (const { name, args, missing } of COMMANDS) {
    it(`${name}: says it was not found and how to find the right name`, async () => {
      const { out, code } = await run(args, cloud.endpoint);
      expect(code, out).toBe(1);
      expect(out).toContain(`Gene '${missing}' not found`);
      expect(out).toMatch(NAME_HINT);
      expect(out).not.toContain(REACHABILITY_HINT);
    });
  }
});

describe("an error status is not a wrong name either", () => {
  for (const { name, args } of [...COMMANDS, { name: "versions", args: ["versions", "@nobody/no-such-gene-xyz"] }]) {
    it(`${name}: keeps the status and gives no name hint`, async () => {
      const { out, code } = await run(args, statusEndpoint);
      expect(code, out).toBe(1);
      expect(out).toContain("Cloud API error (503): Service temporarily unavailable");
      expect(out).not.toMatch(NAME_HINT);
    });
  }
});
