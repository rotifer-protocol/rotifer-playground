import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The real CLI, the real callback port, and a local stand-in for the auth
 * server. The browser is replaced by a script that records the URL.
 */

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const TIMEOUT = 40_000;

describe("rotifer login", () => {
  let home: string;
  let opened: string;
  let stub: Server;
  let stubUrl: string;
  let exchanges: { auth_code: string; code_verifier: string }[];
  let userLookups: (string | undefined)[];
  let acceptExchange: boolean;
  let child: ChildProcess;
  let exitCode: number | null | undefined;
  let output: string;

  const credentials = () => join(home, ".rotifer", "credentials.json");

  function login(args: string[]): void {
    const bin = join(home, "bin");
    mkdirSync(bin);
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), `#!/bin/bash\necho -n "$1" > "${opened}"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    child = spawn("node", [CLI, "login", ...args], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ROTIFER_CLOUD_ANON_KEY: "test-anon" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("exit", (code) => (exitCode = code));
  }

  async function until(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (condition()) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}. CLI output:\n${output}`);
  }

  async function sendCallback(code: string): Promise<void> {
    await until(() => existsSync(opened), "the browser to open");
    await fetch(`http://127.0.0.1:9876/callback?code=${encodeURIComponent(code)}`);
  }

  const exited = () => until(() => exitCode !== undefined, "the CLI to exit");

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "rotifer-login-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    opened = join(home, "opened-url");
    exchanges = [];
    userLookups = [];
    acceptExchange = true;
    exitCode = undefined;
    output = "";
    stub = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/auth/v1/token?grant_type=pkce") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          exchanges.push(JSON.parse(body));
          if (acceptExchange) reply(200, { access_token: "exchanged-access", refresh_token: "exchanged-refresh" });
          else reply(400, { error: "invalid flow state" });
        });
      } else if (req.url === "/auth/v1/user") {
        userLookups.push(req.headers.authorization);
        reply(200, { id: "u1", user_metadata: { user_name: "real-user" } });
      } else {
        reply(404, {});
      }
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (child && exitCode === undefined) {
      child.kill("SIGKILL");
      await until(() => exitCode !== undefined, "the CLI to stop");
    }
    await new Promise((resolve) => stub.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  it("treats an implicit: code like any other code, never as a session", { timeout: TIMEOUT }, async () => {
    acceptExchange = false;
    const forged = "implicit:attacker-session:attacker-refresh";
    login(["--endpoint", stubUrl]);
    await sendCallback(forged);
    await exited();

    expect(exitCode).toBe(1);
    expect(exchanges.map((e) => e.auth_code)).toEqual([forged]);
    expect(userLookups).toEqual([]);
    expect(existsSync(credentials())).toBe(false);
  });

  it("logs in with the session the exchange returned", { timeout: TIMEOUT }, async () => {
    login(["--endpoint", `${stubUrl}/`]);
    await sendCallback("real-code");
    await until(() => existsSync(credentials()), "credentials to be saved");

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].auth_code).toBe("real-code");
    expect(userLookups).toEqual(["Bearer exchanged-access"]);
    expect(JSON.parse(readFileSync(credentials(), "utf-8")).access_token).toBe("exchanged-access");

    const challenge = new URL(readFileSync(opened, "utf-8")).searchParams.get("code_challenge");
    expect(createHash("sha256").update(exchanges[0].code_verifier).digest("base64url")).toBe(challenge);
  });

  it.each([
    ["a file URL", "file:///etc/passwd"],
    ["embedded credentials", "https://someone:hunter2@example.com"],
    ["a control character", "https://example.com/\t"],
  ])("stops before doing anything when --endpoint has %s", { timeout: TIMEOUT }, async (_label, endpoint) => {
    login(["--endpoint", endpoint]);
    await exited();

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Cloud endpoint/);
    expect(output).not.toContain("hunter2");
    expect(existsSync(opened)).toBe(false);
  });

  it("applies the same check to the endpoint in cloud.json", { timeout: TIMEOUT }, async () => {
    writeFileSync(
      join(home, ".rotifer", "cloud.json"),
      JSON.stringify({ endpoint: "https://someone:hunter2@example.com", anonKey: "test-anon" }),
    );
    login([]);
    await exited();

    expect(exitCode).toBe(1);
    expect(output).toMatch(/Cloud endpoint/);
    expect(output).not.toContain("hunter2");
    expect(existsSync(opened)).toBe(false);
  });
});
