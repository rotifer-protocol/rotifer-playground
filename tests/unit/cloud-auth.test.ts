import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), `rotifer-cloud-auth-test-${Date.now()}`);
const CREDS_PATH = join(TEST_HOME, ".rotifer", "credentials.json");

describe("cloud auth module", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_HOME, ".rotifer"), { recursive: true });
    process.env.HOME = TEST_HOME;
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("loadCredentials returns null when no credentials file", async () => {
    const mod = await import("../../src/cloud/auth.js");
    const result = mod.loadCredentials();
    expect(result).toBeNull();
  });

  it("saveCredentials + loadCredentials round-trip", async () => {
    const mod = await import("../../src/cloud/auth.js");
    const creds = {
      access_token: "test-token",
      refresh_token: "test-refresh",
      expires_at: Date.now() + 3600_000,
      user: {
        id: "user-123",
        username: "testdev",
        avatar_url: null,
        github_id: 12345,
      },
    };

    mod.saveCredentials(creds);
    const loaded = mod.loadCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe("test-token");
    expect(loaded!.user.username).toBe("testdev");
  });

  it("loadCredentials returns null for expired tokens", async () => {
    const mod = await import("../../src/cloud/auth.js");
    const creds = {
      access_token: "expired-token",
      refresh_token: "refresh",
      expires_at: Date.now() - 1000,
      user: {
        id: "user-123",
        username: "testdev",
        avatar_url: null,
        github_id: 12345,
      },
    };

    mod.saveCredentials(creds);
    const loaded = mod.loadCredentials();
    expect(loaded).toBeNull();
  });

  it("clearCredentials removes the credentials file", async () => {
    const mod = await import("../../src/cloud/auth.js");
    const creds = {
      access_token: "to-be-cleared",
      refresh_token: "refresh",
      expires_at: Date.now() + 3600_000,
      user: {
        id: "user-123",
        username: "testdev",
        avatar_url: null,
        github_id: 12345,
      },
    };

    mod.saveCredentials(creds);
    expect(mod.isLoggedIn()).toBe(true);

    mod.clearCredentials();
    expect(mod.isLoggedIn()).toBe(false);
  });

  it("requireAuth throws when not logged in", async () => {
    const mod = await import("../../src/cloud/auth.js");
    await expect(mod.requireAuth()).rejects.toThrow("Not logged in");
  });

  it("isLoggedIn returns correct status", async () => {
    const mod = await import("../../src/cloud/auth.js");
    expect(mod.isLoggedIn()).toBe(false);

    mod.saveCredentials({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Date.now() + 3600_000,
      user: { id: "u", username: "dev", avatar_url: null, github_id: 1 },
    });

    expect(mod.isLoggedIn()).toBe(true);
  });
});
