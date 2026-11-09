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

const ALLOW_LISTED_REDIRECT = "http://localhost:9876/callback";

let tokenServer: Server;
let blocker: Server | undefined;
let endpoint: string;

function makeClient() {
  return {
    endpoint,
    anonKey: "stand-in-anon-key",
    setAccessToken: vi.fn(),
    getUserInfo: vi.fn().mockResolvedValue({ id: "u1", username: "alice", avatar_url: null }),
  } as any;
}

function makeContext() {
  return {
    secrets: {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "github" } as any);
  tokenServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "access", refresh_token: "refresh" }));
    });
  });
  endpoint = `http://127.0.0.1:${await listenOn(tokenServer, 0)}`;
});

afterEach(async () => {
  await new Promise((resolve) => tokenServer.close(resolve));
  if (blocker) await new Promise((resolve) => blocker!.close(resolve));
  blocker = undefined;
});

describe("the fixed login callback port", () => {
  // Uses the real port 9876: this test fails if something on the machine already holds it.
  it("sends the allow-listed redirect by default and listens on loopback", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const auth = new AuthManager(makeClient(), makeContext());
    const login = auth.login();

    await vi.waitFor(() => expect(vscode.env.openExternal).toHaveBeenCalledTimes(1));
    const bound = listen.mock.calls.at(-1)?.slice(0, 2);
    listen.mockRestore();
    const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as unknown as { fsPath: string };
    const authorize = new URL(uri.fsPath);

    expect(authorize.searchParams.get("redirect_to")).toBe(ALLOW_LISTED_REDIRECT);
    expect(bound).toEqual([9876, "127.0.0.1"]);

    await fetch(`${ALLOW_LISTED_REDIRECT}?code=code-1&state=${authorize.searchParams.get("state")}`);
    await login;
    expect(auth.isLoggedIn).toBe(true);
  });

  it("explains a port that is already in use and does not open the browser", async () => {
    blocker = createServer();
    const port = await listenOn(blocker, 0);

    const auth = new AuthManager(makeClient(), makeContext(), port);
    await expect(auth.login()).resolves.toBeUndefined();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const message = vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0] as string;
    expect(message).toContain(`Port ${port} is already in use`);
    expect(message).toContain("another Rotifer login");
    expect(message).toContain("try again");
    expect(message).not.toContain("EADDRINUSE");
    expect(vscode.env.openExternal).not.toHaveBeenCalled();
    expect(auth.isLoggedIn).toBe(false);
  });
});
