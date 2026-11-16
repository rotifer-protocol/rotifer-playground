import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { startOAuthCallbackServer } from "../../src/cloud/auth.js";

// node:http does not use the global timers, so real requests still work with them faked.
function hit(port: number, query: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, host: "127.0.0.1", path: `/callback${query}`, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      })
      .on("error", reject);
  });
}

describe("the 120-second login time limit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is cancelled once a code arrives, so nothing keeps the process alive", async () => {
    const { port, waitForCallback } = await startOAuthCallbackServer(0);
    expect(vi.getTimerCount()).toBe(1);

    await hit(port, "?code=abc");

    await expect(waitForCallback).resolves.toBe("abc");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps running after a callback with no code", async () => {
    const { port, waitForCallback } = await startOAuthCallbackServer(0);
    const outcome = expect(waitForCallback).rejects.toThrow("Login timed out after 120 seconds");

    await hit(port, "?error=access_denied");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(120_000);
    await outcome;
  });

  it("ends a login that gets no callback at exactly 120 seconds", async () => {
    const { waitForCallback } = await startOAuthCallbackServer(0);
    const settled = vi.fn();
    waitForCallback.catch(settled);

    vi.advanceTimersByTime(119_999);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await expect(waitForCallback).rejects.toThrow("Login timed out after 120 seconds");
  });
});
