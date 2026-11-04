/**
 * `listGenes` takes an optional abort signal (for `network search`'s 5 s
 * Cloud budget). Without one, the request is exactly what it was before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("listGenes signal", () => {
  const saved = { home: process.env.HOME, endpoint: process.env.ROTIFER_CLOUD_ENDPOINT };
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "rotifer-list-signal-"));
    process.env.HOME = home;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.endpoint === undefined) delete process.env.ROTIFER_CLOUD_ENDPOINT;
    else process.env.ROTIFER_CLOUD_ENDPOINT = saved.endpoint;
  });

  it("sends the same request as before when no signal is given", async () => {
    const { listGenes } = await import("../../src/cloud/client.js");
    await listGenes({ query: "web" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(Object.keys(init).sort()).toEqual(["body", "headers", "method"]);
  });

  it("passes the signal to every request it makes", async () => {
    // A full page with no total forces the second (count) request.
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `g${i}` }));
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(rows), { status: 200 }));
    const { listGenes } = await import("../../src/cloud/client.js");
    const abort = new AbortController();
    await listGenes({ query: "web", signal: abort.signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).signal).toBe(abort.signal);
  });

  it("rejects once the signal aborts", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const { listGenes } = await import("../../src/cloud/client.js");
    const abort = new AbortController();
    const pending = listGenes({ query: "web", signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});
