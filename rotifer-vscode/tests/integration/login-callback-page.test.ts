import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

// The page the browser shows after the callback is written before the code is exchanged
// for a token, so it must not claim the sign-in succeeded: the exchange can still fail.

let tokenServer: Server;
let endpoint: string;
let tokenStatus: number;

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

async function callbackUrl(code: string): Promise<string> {
  await vi.waitFor(() => expect(vscode.env.openExternal).toHaveBeenCalledTimes(1));
  const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as unknown as { fsPath: string };
  const authorize = new URL(uri.fsPath);
  const callback = new URL(authorize.searchParams.get("redirect_to")!);
  callback.searchParams.set("code", code);
  const state = authorize.searchParams.get("state");
  if (state) callback.searchParams.set("state", state);
  return callback.href;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "github" } as any);
  tokenServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(tokenStatus, { "Content-Type": "application/json" });
      res.end(tokenStatus === 200
        ? JSON.stringify({ access_token: "access", refresh_token: "refresh" })
        : JSON.stringify({ error_code: "flow_state_not_found" }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => tokenServer.close(resolve));
});

describe("login callback page", () => {
  it("does not say the sign-in succeeded when the token exchange then fails", async () => {
    tokenStatus = 404;
    const auth = new AuthManager(makeClient(), makeContext());
    const outcome = auth.login();

    const page = await (await fetch(await callbackUrl("code-1"))).text();
    await outcome;

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Login failed: Token exchange failed");
    expect(auth.isLoggedIn).toBe(false);
    expect(page.toLowerCase()).not.toContain("success");
    expect(page).toContain("Return to your editor");
  });

  it("sends the user back to the editor when the exchange succeeds too", async () => {
    tokenStatus = 200;
    const auth = new AuthManager(makeClient(), makeContext());
    const outcome = auth.login();

    const page = await (await fetch(await callbackUrl("code-1"))).text();
    await outcome;

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Signed in as @alice");
    expect(page).toContain("Return to your editor");
  });
});
