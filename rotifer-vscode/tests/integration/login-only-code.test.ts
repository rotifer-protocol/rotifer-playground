import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Stand-in for the auth server's rule: a code only converts with the verifier of its own challenge. */
let issuedCodes: Map<string, string>;
let tokenRequests: Array<{ auth_code: string; code_verifier: string }>;
let tokenServer: Server;
let endpoint: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: "github" } as any);
  issuedCodes = new Map();
  tokenRequests = [];
  tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body);
      tokenRequests.push(request);
      const accepted = issuedCodes.get(request.auth_code) === challengeOf(request.code_verifier);
      res.writeHead(accepted ? 200 : 403, { "Content-Type": "application/json" });
      res.end(JSON.stringify(accepted ? { access_token: "exchanged-access", refresh_token: "exchanged-refresh" } : { error_code: "bad_code_verifier" }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => tokenServer.close(resolve));
});

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

async function startLogin() {
  const client = {
    endpoint,
    anonKey: "stand-in-anon-key",
    setAccessToken: vi.fn(),
    getUserInfo: vi.fn().mockResolvedValue({ id: "u1", username: "alice", avatar_url: null }),
  } as any;
  const secrets = {
    get: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const auth = new AuthManager(client, { secrets } as any, 0);
  const login = auth.login();
  await vi.waitFor(() => expect(vscode.env.openExternal).toHaveBeenCalledTimes(1));
  const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as unknown as { fsPath: string };
  const authorize = new URL(uri.fsPath);
  const callback = authorize.searchParams.get("redirect_to")!;
  return { auth, client, secrets, login, authorize, callback, port: Number(new URL(callback).port) };
}

function expectNotSignedIn(session: Awaited<ReturnType<typeof startLogin>>) {
  expect(session.auth.isLoggedIn).toBe(false);
  expect(session.secrets.store).not.toHaveBeenCalled();
  expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
}

describe("login accepts only a PKCE code", () => {
  it("asks for a code with an S256 challenge and sends no state", async () => {
    const session = await startLogin();

    expect(session.authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(session.authorize.searchParams.has("state")).toBe(false);

    await fetch(`${session.callback}?code=finish`);
    await session.login;
  });

  it("signs in with a code that converts with this login's verifier, with no state on the callback", async () => {
    const session = await startLogin();
    issuedCodes.set("real", session.authorize.searchParams.get("code_challenge")!);

    await fetch(`${session.callback}?code=real`);
    await session.login;

    expect(session.auth.isLoggedIn).toBe(true);
    expect(JSON.parse(session.secrets.store.mock.calls[0][1]).access_token).toBe("exchanged-access");
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("does not sign in with tokens handed to the callback", async () => {
    const session = await startLogin();

    await fetch(`${session.callback}?access_token=attacker&refresh_token=attacker-refresh`);
    await session.login;

    expectNotSignedIn(session);
    expect(tokenRequests).toHaveLength(0);
    expect(session.client.setAccessToken).not.toHaveBeenCalledWith("attacker");
  });

  it("ignores tokens that arrive alongside a code", async () => {
    const session = await startLogin();
    issuedCodes.set("real", session.authorize.searchParams.get("code_challenge")!);

    await fetch(`${session.callback}?code=real&access_token=attacker&refresh_token=attacker-refresh`);
    await session.login;

    expect(session.client.setAccessToken).not.toHaveBeenCalledWith("attacker");
    expect(JSON.parse(session.secrets.store.mock.calls[0][1]).access_token).toBe("exchanged-access");
  });

  it("does not sign in with a code issued to someone else's login", async () => {
    const session = await startLogin();
    issuedCodes.set("forged", challengeOf("attacker-verifier"));

    await fetch(`${session.callback}?code=forged`);
    await session.login;

    expectNotSignedIn(session);
    expect(tokenRequests).toHaveLength(1);
    expect(challengeOf(tokenRequests[0].code_verifier)).toBe(session.authorize.searchParams.get("code_challenge"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Login failed: Token exchange failed");
  });

  it.each([
    ["a bare callback", ""],
    ["a denied authorization", "?error=access_denied&error_description=denied"],
  ])("does not sign in on %s", async (_name, query) => {
    const session = await startLogin();

    await fetch(`${session.callback}${query}`);
    await session.login;

    expectNotSignedIn(session);
    expect(tokenRequests).toHaveLength(0);
  });

  it("takes only the first code: a forged one fails this login and the real one is not used", async () => {
    const session = await startLogin();
    issuedCodes.set("forged", challengeOf("attacker-verifier"));
    issuedCodes.set("real", session.authorize.searchParams.get("code_challenge")!);

    await fetch(`${session.callback}?code=forged`);
    expect(await accepts(session.port)).toBe(false);
    await fetch(`${session.callback}?code=real`).catch(() => undefined);
    await session.login;

    expectNotSignedIn(session);
    expect(tokenRequests.map((r) => r.auth_code)).toEqual(["forged"]);
  });
});
