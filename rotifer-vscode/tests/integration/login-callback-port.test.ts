import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";

vi.mock("vscode", () => import("../__mocks__/vscode"));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { AuthManager } from "../../src/auth";
import * as vscode from "vscode";

// node:http is deliberately not mocked here: the bug this guards against only
// exists on a real server, where listen() with a host finishes asynchronously.

let tokenServer: Server;
let endpoint: string;
let tokenRequests: Array<{ auth_code: string; code_verifier: string }>;
let listenSpy: { mockRestore(): void } | undefined;

function makeContext() {
  return {
    secrets: {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function makeClient() {
  return {
    endpoint,
    anonKey: "stand-in-anon-key",
    setAccessToken: vi.fn(),
    getUserInfo: vi.fn().mockResolvedValue({ id: "u1", username: "alice", avatar_url: null }),
  } as any;
}

function settle(login: Promise<void>): Promise<unknown> {
  return login.then(
    () => "resolved",
    (err) => err,
  );
}

// A new TCP connection each time: fetch may reuse a keep-alive connection to a closed server.
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function openedAuthorizeUrl(): Promise<URL> {
  await vi.waitFor(() => expect(vscode.env.openExternal).toHaveBeenCalledTimes(1));
  const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as unknown as { fsPath: string };
  return new URL(uri.fsPath);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "github" } as any);
  tokenRequests = [];
  tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      tokenRequests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "access", refresh_token: "refresh" }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  listenSpy?.mockRestore();
  listenSpy = undefined;
  await new Promise((resolve) => tokenServer.close(resolve));
});

describe("login callback port", () => {
  it("opens the browser with the port it is really listening on", async () => {
    const auth = new AuthManager(makeClient(), makeContext());
    const outcome = settle(auth.login());

    const authorize = await openedAuthorizeUrl();
    const redirect = new URL(authorize.searchParams.get("redirect_to")!);
    expect(authorize.pathname).toBe("/auth/v1/authorize");
    expect(await accepts(Number(redirect.port))).toBe(true);

    const state = authorize.searchParams.get("state")!;
    const callback = await fetch(`${redirect.href}?code=code-1&state=${state}`);

    expect(callback.status).toBe(200);
    expect(await outcome).toBe("resolved");
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].auth_code).toBe("code-1");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Signed in as @alice");
    expect(auth.isLoggedIn).toBe(true);
  });

  it("stops listening once the callback has arrived", async () => {
    const auth = new AuthManager(makeClient(), makeContext());
    const outcome = settle(auth.login());

    const authorize = await openedAuthorizeUrl();
    const redirect = new URL(authorize.searchParams.get("redirect_to")!);
    const state = authorize.searchParams.get("state")!;
    await fetch(`${redirect.href}?code=code-1&state=${state}`);
    await outcome;

    expect(await accepts(Number(redirect.port))).toBe(false);
  });

  it("reports a port that cannot be opened and does not open the browser", async () => {
    listenSpy = vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (this: net.Server) {
      process.nextTick(() => this.emit("error", new Error("listen EACCES: permission denied")));
      return this;
    });

    const auth = new AuthManager(makeClient(), makeContext());

    expect(await settle(auth.login())).toBe("resolved");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Login failed: Cannot start callback server: listen EACCES: permission denied",
    );
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(auth.isLoggedIn).toBe(false);
  });
});
