import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:http", () => ({
  createServer: vi.fn(),
}));

import { AuthManager } from "../../src/auth";
import { RotiferCloudClient } from "../../src/cloud-client";
import * as vscode from "vscode";
import * as fs from "node:fs";

function makeClient(): RotiferCloudClient {
  const client = new RotiferCloudClient();
  client.setAccessToken = vi.fn();
  client.getUserInfo = vi.fn().mockResolvedValue({ id: "u1", username: "alice", avatar_url: null });
  return client;
}

const VALID_CREDS = {
  access_token: "at-valid",
  refresh_token: "rt-valid",
  expires_at: Date.now() + 3600_000,
  provider: "github",
  user: { id: "u1", username: "alice", avatar_url: null, provider_id: "gh-1" },
};

describe("AuthManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe("constructor", () => {
    it("creates a status bar item on the right side", () => {
      const client = makeClient();
      new AuthManager(client);
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Right,
        100,
      );
    });

    it("sets authMenu as status bar command", () => {
      const client = makeClient();
      const auth = new AuthManager(client);
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      expect(statusBar.command).toBe("rotifer.authMenu");
    });

    it("shows the status bar item", () => {
      const client = makeClient();
      new AuthManager(client);
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      expect(statusBar.show).toHaveBeenCalled();
    });
  });

  describe("isLoggedIn", () => {
    it("returns false when no credentials loaded", () => {
      const auth = new AuthManager(makeClient());
      expect(auth.isLoggedIn).toBe(false);
    });

    it("returns true when valid credentials exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const auth = new AuthManager(makeClient());
      expect(auth.isLoggedIn).toBe(true);
    });
  });

  describe("username", () => {
    it("returns null when not logged in", () => {
      const auth = new AuthManager(makeClient());
      expect(auth.username).toBeNull();
    });

    it("returns username from stored credentials", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const auth = new AuthManager(makeClient());
      expect(auth.username).toBe("alice");
    });
  });

  describe("disposables", () => {
    it("includes the status bar item", () => {
      const auth = new AuthManager(makeClient());
      expect(auth.disposables).toHaveLength(1);
      expect(auth.disposables[0]).toHaveProperty("dispose");
    });
  });

  describe("loadCredentials (via constructor)", () => {
    it("ignores expired credentials", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ...VALID_CREDS, expires_at: Date.now() - 1000 }),
      );
      const client = makeClient();
      const auth = new AuthManager(client);
      expect(auth.isLoggedIn).toBe(false);
      expect(client.setAccessToken).toHaveBeenCalledWith(null);
    });

    it("sets client token when credentials are valid", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const client = makeClient();
      new AuthManager(client);
      expect(client.setAccessToken).toHaveBeenCalledWith("at-valid");
    });

    it("handles malformed JSON gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("{{bad}}");
      const auth = new AuthManager(makeClient());
      expect(auth.isLoggedIn).toBe(false);
    });
  });

  describe("updateStatusBar", () => {
    it("shows sign-in prompt when not logged in", () => {
      const auth = new AuthManager(makeClient());
      auth.updateStatusBar();
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      expect(statusBar.text).toContain("Sign in");
    });

    it("shows username when logged in", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const auth = new AuthManager(makeClient());
      auth.updateStatusBar();
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      expect(statusBar.text).toContain("alice");
    });

    it("includes provider in tooltip when logged in", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const auth = new AuthManager(makeClient());
      auth.updateStatusBar();
      const statusBar = vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;
      expect(statusBar.tooltip).toContain("github");
    });
  });

  describe("login", () => {
    it("shows info message if already logged in", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const auth = new AuthManager(makeClient());
      await auth.login();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Already logged in"),
      );
    });

    it("shows provider picker when not logged in", async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as any);
      const auth = new AuthManager(makeClient());
      await auth.login();
      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ value: "github" }),
          expect.objectContaining({ value: "gitlab" }),
        ]),
        expect.objectContaining({ title: "Sign in to Rotifer Cloud" }),
      );
    });

    it("aborts when user cancels provider selection", async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as any);
      const auth = new AuthManager(makeClient());
      await auth.login();
      expect(vscode.env.openExternal).not.toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("shows info when not logged in", async () => {
      const auth = new AuthManager(makeClient());
      await auth.logout();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Not currently signed in.",
      );
    });

    it("clears credentials and shows sign-out message", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const client = makeClient();
      const auth = new AuthManager(client);
      expect(auth.isLoggedIn).toBe(true);

      await auth.logout();

      expect(auth.isLoggedIn).toBe(false);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Signed out"),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("alice"),
      );
    });

    it("resets client access token on logout", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(VALID_CREDS));
      const client = makeClient();
      const auth = new AuthManager(client);
      await auth.logout();
      expect(client.setAccessToken).toHaveBeenCalledWith(null);
    });
  });
});
