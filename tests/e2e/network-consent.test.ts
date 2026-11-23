/**
 * First-run P2P consent on real CLI processes (T-237 design §5, T1–T7 and the
 * "no peers configured" check; T8 is the unit test p2p-consent.test.ts).
 *
 * The ruler is a plain TCP listener on 127.0.0.1 passed as the bootstrap
 * peer: libp2p opens a TCP connection before anything else, so the number of
 * connections it accepted is the number of times the CLI dialled out. T3 and
 * T5 "y" are the positive controls that show the ruler can see a dial.
 *
 * T1, T2, T4, T5 "n"/Enter and T6 need no native module (the gates stop
 * before it loads). T3, T5 "y", T7 and the 30 s check need one with
 * `NodeIdentity`; without it they are skipped and say so, and with
 * ROTIFER_REQUIRE_NATIVE_P2P=1 or ROTIFER_REQUIRE_NATIVE_MEMORY=1 (CI's
 * "freshly built napi" step) the file fails instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const CLI = process.env.ROTIFER_E2E_CLI ?? join(__dirname, "..", "..", "dist", "index.js");
const ROOT = mkdtempSync(join(tmpdir(), "rotifer-consent-e2e-"));
const BASE_ENV = { ...process.env, ROTIFER_CLOUD_ENDPOINT: "http://127.0.0.1:9", ROTIFER_NO_UPDATE_CHECK: "1" };

/** A valid PeerId for the fake bootstrap address (public, made in memory once). */
const FAKE_PEER_ID = "12D3KooW9tdQtnXABz4KN8Sv8U1pFr7ZrYZMPaRL8d683sNeJvxy";
const NOTICE_HEAD = "P2P networking is off for this account. Starting the node turns it on.";
const QUESTION = "Allow P2P networking for this account? [y/N]";
const KEY_FILE = ["identity", "pem"].join(".");

interface Listener {
  addr: string;
  accepted: () => number;
  open: () => number;
  close: () => Promise<void>;
}

/** The fake bootstrap peer: accepts TCP, says nothing, counts. */
function listener(): Promise<Listener> {
  return new Promise((resolve, reject) => {
    let accepted = 0;
    const sockets = new Set<Socket>();
    const srv: Server = createServer((s) => {
      accepted += 1;
      sockets.add(s);
      s.on("error", () => undefined);
      // Read and drop: a paused socket never sees the peer's FIN, so "close" would not fire.
      s.resume();
      s.on("close", () => sockets.delete(s));
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      resolve({
        addr: `/ip4/127.0.0.1/tcp/${port}/p2p/${FAKE_PEER_ID}`,
        accepted: () => accepted,
        open: () => sockets.size,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            srv.close(() => r());
          }),
      });
    });
  });
}

function newHome(name: string): string {
  const home = join(ROOT, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function cli(home: string, args: string[], timeout = 25_000): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...BASE_ENV, HOME: home },
    input: "",
    timeout,
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const rotifer = (home: string, ...p: string[]): string => join(home, ".rotifer", ...p);
const consentFile = (home: string): string => rotifer(home, "p2p", "consent.json");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function until(secs: number, check: () => Promise<boolean> | boolean): Promise<boolean> {
  for (const end = Date.now() + secs * 1000; Date.now() < end; ) {
    try {
      if (await check()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rawStatus(home: string): Promise<{ peerId: string; connectedPeers?: number; peers?: number }> {
  const state = JSON.parse(readFileSync(rotifer(home, "daemon.json"), "utf-8")) as { port: number; token: string };
  const res = await fetch(`http://127.0.0.1:${state.port}/status`, { headers: { "x-rotifer-token": state.token } });
  return (await res.json()) as { peerId: string; connectedPeers?: number; peers?: number };
}

async function controlAnswers(home: string, port: number, token: string): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { headers: { "x-rotifer-token": token } });
    return true;
  } catch {
    return false;
  }
}

function exited(child: ChildProcess, secs: number): Promise<number | null | "running"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("running"), secs * 1000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `node CLI args…` on a pseudo-terminal through the system `script`
 * command (no new dependency). Sends `answer` once the question shows and
 * keeps stdin open until the CLI exits.
 *
 * macOS `script` refuses a socket or a FIFO as its stdin or stdout (both are
 * sockets inside XNU), and Node's pipes are sockets, so `sh` puts `cat` on
 * either side to turn them into plain pipes. `script` passes the CLI's exit
 * code on (`-e` on Linux); `sh` prints it as a marker on stderr, and only
 * then is stdin closed, which lets `cat` and `sh` end.
 */
async function onTerminal(home: string, args: string[], answer: string): Promise<{ code: number | null | "running"; out: string }> {
  return onTerminalRun(home, ["node", CLI, ...args], answer);
}

/** `onTerminal` for any command line (`argv[0]` is the program). */
async function onTerminalRun(home: string, argv: string[], answer: string): Promise<{ code: number | null | "running"; out: string }> {
  const run =
    process.platform === "darwin"
      ? 'script -q /dev/null "$@"'
      : 'script -q -e -c "$(printf "%s " "$@")" /dev/null';
  const wrapper = `cat | { ${run}; echo "__EXIT:$?" >&2; } | cat`;
  const command = process.platform === "darwin" ? argv : argv.map(quote);
  const child = spawn("sh", ["-c", wrapper, "sh", ...command], {
    env: { ...BASE_ENV, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let sent = false;
  let code: number | null | "running" = "running";
  const done = new Promise<void>((resolve) => {
    const onData = (d: Buffer): void => {
      out += String(d);
      if (!sent && out.includes(QUESTION)) {
        sent = true;
        child.stdin?.write(answer);
      }
      const m = /__EXIT:(\d+)/.exec(out);
      if (m && code === "running") {
        code = Number(m[1]);
        out = out.replace(m[0], "");
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
  await Promise.race([done, sleep(40_000)]);
  child.stdin?.end();
  if ((await exited(child, 5)) === "running") child.kill("SIGKILL");
  return { code, out };
}

/** Whether the native module this CLI loads has `NodeIdentity` (B5). */
function addonHasNodeIdentity(): boolean {
  const binding = pathToFileURL(join(dirname(CLI), "utils", "binding.js")).href;
  const probe = [
    `const { loadNodeIdentity } = await import(${JSON.stringify(binding)});`,
    `const id = loadNodeIdentity();`,
    `console.log(id && id !== "outdated" && typeof id.peerId === "string" ? "yes" : "no");`,
    `process.exit(0);`,
  ].join("\n");
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], {
      env: { ...process.env, HOME: join(ROOT, "probe") },
      timeout: 20_000,
      encoding: "utf-8",
    });
    return out.trim().endsWith("yes");
  } catch {
    return false;
  }
}

const HAS_IDENTITY = addonHasNodeIdentity();
if (!HAS_IDENTITY) {
  const required =
    process.env.ROTIFER_REQUIRE_NATIVE_P2P === "1" || process.env.ROTIFER_REQUIRE_NATIVE_MEMORY === "1";
  if (required) throw new Error("the native addon lacks NodeIdentity (T-237)");
  console.warn("skipped T3, T5 'y', T7 and the 30 s check: no native addon, or it predates NodeIdentity");
}

/** Nothing the consent gate must not write before consent. */
function assertNothingWritten(home: string): void {
  expect(existsSync(rotifer(home, "daemon.json"))).toBe(false);
  expect(existsSync(rotifer(home, KEY_FILE))).toBe(false);
  expect(existsSync(consentFile(home))).toBe(false);
}

let fake: Listener;

beforeAll(async () => {
  fake = await listener();
});

/**
 * Stop any daemon a test home still has, so a failing run (a mutation that
 * lets the node start) leaves no orphan node behind.
 */
function stopLeftoverDaemons(): void {
  if (!existsSync(ROOT)) return;
  for (const name of readdirSync(ROOT)) {
    const state = join(ROOT, name, ".rotifer", "daemon.json");
    if (!existsSync(state)) continue;
    try {
      const { pid } = JSON.parse(readFileSync(state, "utf-8")) as { pid?: unknown };
      if (typeof pid === "number" && pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      // gone already, or the file is not a daemon state
    }
  }
}

afterAll(async () => {
  stopLeftoverDaemons();
  await fake?.close();
  rmSync(ROOT, { recursive: true, force: true });
}, 30_000);

describe("without consent nothing dials out", () => {
  it("T1: non-terminal start refuses, exits 1, writes nothing, makes no connection", async () => {
    const home = newHome("t1");
    const before = fake.accepted();
    const r = cli(home, ["network", "start", "-b", fake.addr]);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stderr).toContain("P2P networking needs your consent first");
    await sleep(5_000);
    expect(fake.accepted() - before).toBe(0);
    assertNothingWritten(home);
  }, 30_000);

  it("T2: --json gives P2P_CONSENT_REQUIRED and no question, no connection", async () => {
    const home = newHome("t2");
    const before = fake.accepted();
    const r = cli(home, ["--json", "network", "start", "-b", fake.addr]);
    expect(r.code, r.stderr).toBe(1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("P2P_CONSENT_REQUIRED");
    expect(r.stdout).not.toContain(QUESTION);
    await sleep(5_000);
    expect(fake.accepted() - before).toBe(0);
    assertNothingWritten(home);
  }, 30_000);

  it("T4: running the hidden daemon directly stops at G2, exits 1, no connection", async () => {
    const home = newHome("t4");
    const before = fake.accepted();
    const r = cli(home, ["network", "__daemon", "--port", "0", "--bootstrap", fake.addr]);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stderr).toContain("P2P daemon not started: no consent recorded in ~/.rotifer/p2p/consent.json.");
    await sleep(5_000);
    expect(fake.accepted() - before).toBe(0);
    expect(existsSync(rotifer(home, KEY_FILE))).toBe(false);
  }, 30_000);

  it("T6: with stdin held open and not a terminal, start exits within 5 s", async () => {
    const home = newHome("t6");
    const before = fake.accepted();
    const child = spawn("node", [CLI, "network", "start", "-b", fake.addr], {
      env: { ...BASE_ENV, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stdin stays open: no EOF is written until the child is gone.
    const started = Date.now();
    const code = await exited(child, 5);
    child.stdin?.end();
    if (code === "running") child.kill("SIGKILL");
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fake.accepted() - before).toBe(0);
    assertNothingWritten(home);
  }, 20_000);

  for (const [name, answer] of [
    ["n", "n\r"],
    ["empty Enter", "\r"],
  ] as const) {
    it(`T5: on a terminal, answering ${name} starts nothing, saves nothing, exits 0`, async () => {
      const home = newHome(`t5-${name.replace(/\s/g, "-")}`);
      const before = fake.accepted();
      const r = await onTerminal(home, ["network", "start", "-b", fake.addr], answer);
      expect(r.out).toContain(NOTICE_HEAD);
      expect(r.out).toContain(QUESTION);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("Not started. P2P networking stays off; nothing was saved.");
      await sleep(5_000);
      expect(fake.accepted() - before).toBe(0);
      assertNothingWritten(home);
    }, 60_000);
  }
  it("X4: stdout a terminal but stdin a pipe giving y: no question, exits 1, saves nothing, no connection", async () => {
    const home = newHome("x4");
    const before = fake.accepted();
    // On the pseudo-terminal, `sh` pipes "y" into the CLI's stdin, so only its
    // stdout and stderr are the terminal (`yes | rotifer network start`).
    const piped = 'printf "y\\ny\\n" | exec node "$0" "$@"';
    const r = await onTerminalRun(home, ["sh", "-c", piped, CLI, "network", "start", "-b", fake.addr], "");
    expect(r.out).not.toContain(QUESTION);
    expect(r.out).toContain("P2P networking needs your consent first");
    expect(r.code, r.out).toBe(1);
    await sleep(5_000);
    expect(fake.accepted() - before).toBe(0);
    assertNothingWritten(home);
  }, 60_000);
});

describe.skipIf(!HAS_IDENTITY)("with consent the node starts, and revoking stops it", () => {
  const homeT3 = join(ROOT, "t3");
  const homeY = join(ROOT, "t5-y");
  const homeEmpty = join(ROOT, "empty");

  afterAll(() => {
    for (const h of [homeT3, homeY, homeEmpty]) if (existsSync(h)) cli(h, ["network", "stop"]);
  }, 60_000);

  it("T3 (positive control): --accept-p2p prints the notice, records source=flag 0600, dials the bootstrap", async () => {
    mkdirSync(homeT3, { recursive: true });
    const before = fake.accepted();
    const r = cli(homeT3, ["network", "start", "--port", "0", "-b", fake.addr, "--accept-p2p"], 40_000);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain(NOTICE_HEAD);
    expect(await until(20, () => fake.accepted() - before >= 1)).toBe(true);
    const record = JSON.parse(readFileSync(consentFile(homeT3), "utf-8")) as { source: string };
    expect(record.source).toBe("flag");
    expect(statSync(consentFile(homeT3)).mode & 0o777).toBe(0o600);
  }, 60_000);

  it("T7: --revoke stops the daemon and its connection; the key stays unchanged; start then gives T1's result", async () => {
    const state = JSON.parse(readFileSync(rotifer(homeT3, "daemon.json"), "utf-8")) as { port: number; token: string; pid: number };
    expect(await controlAnswers(homeT3, state.port, state.token)).toBe(true);
    const keyBefore = sha256(rotifer(homeT3, KEY_FILE));

    const r = cli(homeT3, ["network", "consent", "--revoke"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(consentFile(homeT3))).toBe(false);
    expect(await until(15, async () => !(await controlAnswers(homeT3, state.port, state.token)))).toBe(true);
    expect(await until(15, () => !alive(state.pid)), "daemon process still alive").toBe(true);
    expect(await until(15, () => fake.open() === 0), `open connections: ${fake.open()}`).toBe(true);
    const afterStop = fake.accepted();
    await sleep(5_000);
    expect(fake.accepted()).toBe(afterStop);

    // The node key is kept as it was (compared by digest, never printed).
    expect(existsSync(rotifer(homeT3, KEY_FILE))).toBe(true);
    expect(sha256(rotifer(homeT3, KEY_FILE))).toBe(keyBefore);

    const again = cli(homeT3, ["network", "start", "-b", fake.addr]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("P2P networking needs your consent first");
    await sleep(5_000);
    expect(fake.accepted()).toBe(afterStop);
    expect(existsSync(consentFile(homeT3))).toBe(false);
  }, 90_000);

  it("T5: on a terminal, answering y records source=prompt, keeps the shown PeerId, dials the bootstrap", async () => {
    mkdirSync(homeY, { recursive: true });
    const before = fake.accepted();
    const r = await onTerminal(homeY, ["network", "start", "--port", "0", "-b", fake.addr], "y\r");
    expect(r.code, r.out).toBe(0);
    const shown = /this node's ID, (\S+), kept in/.exec(r.out)?.[1];
    expect(shown, r.out).toMatch(/^12D3KooW/);
    expect(await until(20, () => fake.accepted() - before >= 1)).toBe(true);
    const record = JSON.parse(readFileSync(consentFile(homeY), "utf-8")) as { source: string };
    expect(record.source).toBe("prompt");
    // The key on disk is the one the notice showed.
    expect((await rawStatus(homeY)).peerId).toBe(shown);
  }, 90_000);

  it("with consent and nothing configured, the node connects to nothing for 30 s", async () => {
    mkdirSync(rotifer(homeEmpty, "p2p"), { recursive: true });
    writeFileSync(rotifer(homeEmpty, "peers.json"), "[]\n");
    expect(cli(homeEmpty, ["network", "consent", "--accept"]).code).toBe(0);
    const r = cli(homeEmpty, ["network", "start", "--port", "0"], 40_000);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    await sleep(30_000);
    const s = await rawStatus(homeEmpty);
    expect(s.connectedPeers).toBe(0);
  }, 90_000);
});
