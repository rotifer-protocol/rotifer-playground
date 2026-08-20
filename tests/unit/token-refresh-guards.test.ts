import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CloudCredentials } from "../../src/cloud/types.js";

/**
 * `refreshTokenIfNeeded` decides whether an expired credential gets renewed,
 * on two lines:
 *
 *   if (!data.expires_at || Date.now() <= data.expires_at) return;
 *   if (!data.refresh_token) return;
 *
 * Mutation testing found ten mutants on those two lines and not one of them
 * was covered — flip `<=` to `>`, or delete either guard, and the suite stayed
 * green. There *was* a test for expiry, `tests/resilience/token-expiry.test.ts`,
 * and it could not have caught any of them: it runs `execSync('node ' + CLI)`,
 * so it exercises the built binary's behaviour and never executes this source.
 *
 * These tests import the function. Each one pins a single decision the guards
 * make, and asserts it through the only observable that distinguishes them —
 * whether the network call happens at all.
 */

const TEST_HOME = join(tmpdir(), `rotifer-refresh-guards-${Date.now()}`);
const CREDS_PATH = join(TEST_HOME, ".rotifer", "credentials.json");
const ORIGINAL_HOME = process.env.HOME;

const HOUR = 3_600_000;

function writeCreds(partial: Partial<CloudCredentials>): void {
  const creds = {
    access_token: "stale-access-token",
    refresh_token: "a-refresh-token",
    user: { id: "u1", username: "dev", avatar_url: null, github_id: 1 },
    ...partial,
  };
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** A refresh endpoint that answers, so a call that happens is visibly a call. */
function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

describe("refreshTokenIfNeeded — the guards that decide whether to renew", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mkdirSync(join(TEST_HOME, ".rotifer"), { recursive: true, mode: 0o700 });
    process.env.HOME = TEST_HOME;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  it("renews a credential that has expired", async () => {
    writeCreds({ expires_at: Date.now() - HOUR });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("grant_type=refresh_token");
  });

  it("leaves a credential that is still valid alone", async () => {
    writeCreds({ expires_at: Date.now() + HOUR });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    // A guard mutated to `false` would renew a perfectly good token on every
    // command, which costs the auth server a request per invocation and shows
    // up nowhere else.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats the exact moment of expiry as not yet expired", async () => {
    // The boundary the `<=` owns. With `<` in its place the credential is
    // renewed one millisecond early — invisible in any test that does not sit
    // exactly on the instant.
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    writeCreds({ expires_at: now });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews one millisecond past expiry", async () => {
    // The other side of the same boundary, so the pair pins `<=` from both
    // directions rather than only ruling one mutant out.
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    writeCreds({ expires_at: now - 1 });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no expiry was ever recorded", async () => {
    // `!data.expires_at ||` — with `&&` in place of `||`, a credential that
    // never recorded an expiry would be sent for renewal on every command.
    writeCreds({ expires_at: undefined });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when expired with nothing to renew from", async () => {
    writeCreds({ expires_at: Date.now() - HOUR, refresh_token: undefined });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    // Without this guard the request goes out carrying `refresh_token:
    // undefined` and fails at the far end, which is a worse way to learn the
    // same thing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes the renewed credential to disk", async () => {
    writeCreds({ expires_at: Date.now() - HOUR });
    stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    const saved = JSON.parse(readFileSync(CREDS_PATH, "utf-8")) as CloudCredentials;
    expect(saved.access_token).toBe("fresh-access-token");
    expect(saved.refresh_token).toBe("fresh-refresh-token");
    expect(saved.expires_at).toBeGreaterThan(Date.now());
  });

  it("keeps the old credential when the endpoint refuses", async () => {
    writeCreds({ expires_at: Date.now() - HOUR });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 })) as unknown as typeof globalThis.fetch;
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await refreshTokenIfNeeded();

    const saved = JSON.parse(readFileSync(CREDS_PATH, "utf-8")) as CloudCredentials;
    expect(saved.access_token).toBe("stale-access-token");
  });

  it("survives an unreadable credentials file", async () => {
    writeFileSync(CREDS_PATH, "{ not json", { mode: 0o600 });
    const fetchMock = stubFetch();
    const { refreshTokenIfNeeded } = await import("../../src/cloud/auth.js");

    await expect(refreshTokenIfNeeded()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
