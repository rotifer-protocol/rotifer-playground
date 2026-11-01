import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/**
 * The recorded Rotifer Cloud (tests/fixtures/cloud/), for suites whose
 * commands reach the registry. Point the CLI at `endpoint` with
 * ROTIFER_CLOUD_ENDPOINT.
 *
 * Those suites used to call the real cloud.rotifer.dev from every PR. With
 * the cloud refusing connections they still passed, but with the cloud slow
 * or hanging eight of their tests timed out (measured 2026-11-01), and a
 * reset connection turned `versions` red. The real cloud is checked on a
 * schedule instead: tests/live/cloud-live.test.ts.
 */
export interface RecordedCloud {
  endpoint: string;
  /** Requests the fixture had no answer for. A suite must end with none. */
  unrecorded: () => Promise<string[]>;
  close: () => Promise<void>;
}

const SERVER = join(__dirname, "../fixtures/cloud/server.mjs");

export function startRecordedCloud(): Promise<RecordedCloud> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [SERVER], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`recorded cloud exited (${code}) before listening`)));
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf-8");
      const m = /listening (\d+)/.exec(out);
      if (!m) return;
      child.removeAllListeners("exit");
      const endpoint = `http://127.0.0.1:${m[1]}`;
      resolve({
        endpoint,
        unrecorded: async () => (await fetch(`${endpoint}/__unrecorded`)).json() as Promise<string[]>,
        close: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            child.once("exit", () => done());
            child.kill();
          }),
      });
    });
  });
}
