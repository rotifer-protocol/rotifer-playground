import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for Issue #50 UX 4 — `rotifer whoami` previously read
 * credentials synchronously and reported "Not logged in" the moment the
 * access token expired, even though the refresh token was still valid.
 *
 * Fix: whoami awaits refreshTokenIfNeeded() before loadCredentials(), so
 * a fresh access token is on disk by the time we render status.
 */

const { loadCredentialsMock, refreshTokenIfNeededMock } = vi.hoisted(() => ({
  loadCredentialsMock: vi.fn(),
  refreshTokenIfNeededMock: vi.fn(),
}));

vi.mock("../../src/cloud/auth.js", () => ({
  loadCredentials: loadCredentialsMock,
  refreshTokenIfNeeded: refreshTokenIfNeededMock,
}));

import { whoamiCommand } from "../../src/commands/whoami.js";

describe("whoami auto-refresh (Issue #50 UX 4)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    refreshTokenIfNeededMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    loadCredentialsMock.mockReset();
    refreshTokenIfNeededMock.mockReset();
  });

  it("awaits refreshTokenIfNeeded BEFORE loadCredentials", async () => {
    // Track call ordering — refresh must complete before we read.
    const callOrder: string[] = [];
    refreshTokenIfNeededMock.mockImplementation(async () => {
      callOrder.push("refresh");
    });
    loadCredentialsMock.mockImplementation(() => {
      callOrder.push("load");
      return {
        access_token: "fresh-tok",
        refresh_token: "ref",
        expires_at: Date.now() + 3600_000,
        provider: "github",
        user: {
          id: "u-1",
          username: "alice",
          avatar_url: null,
          provider_id: "123",
        },
      };
    });

    await whoamiCommand.parseAsync([], { from: "user" });

    expect(callOrder).toEqual(["refresh", "load"]);
    expect(refreshTokenIfNeededMock).toHaveBeenCalledTimes(1);
  });

  it("reports authenticated when refreshTokenIfNeeded restored credentials", async () => {
    loadCredentialsMock.mockReturnValue({
      access_token: "fresh-tok",
      refresh_token: "ref",
      expires_at: Date.now() + 3600_000,
      provider: "github",
      user: {
        id: "u-1",
        username: "alice",
        avatar_url: null,
        provider_id: "123",
      },
    });

    await whoamiCommand.parseAsync([], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("@alice");
    expect(output).not.toContain("Not logged in");
  });

  it("still reports Not logged in when refresh failed AND no credentials on disk", async () => {
    // refreshTokenIfNeeded silently no-ops when there's no refresh token
    // available; loadCredentials returns null → whoami should NOT crash
    // and should fall through to the "Not logged in" branch.
    loadCredentialsMock.mockReturnValue(null);

    await whoamiCommand.parseAsync([], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Not logged in");
    expect(refreshTokenIfNeededMock).toHaveBeenCalledTimes(1);
  });
});
