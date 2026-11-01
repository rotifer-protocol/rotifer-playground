import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudNetworkError, listGeneVersions, toCloudNetworkError } from "../../src/cloud/client.js";

/** What Node's fetch throws for a network failure: a TypeError with the reason in `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

describe("toCloudNetworkError", () => {
  it("names the endpoint's origin, not the full request URL", () => {
    const err = toCloudNetworkError(
      "https://cloud.example.test/rest/v1/genes?name=eq.x",
      fetchFailed({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND cloud.example.test" }),
    );
    expect(err).toBeInstanceOf(CloudNetworkError);
    expect(err.message).toBe("Cannot reach Rotifer Cloud (https://cloud.example.test): host not found (ENOTFOUND)");
    expect(err.endpoint).toBe("https://cloud.example.test");
    expect(err.code).toBe("ENOTFOUND");
  });

  it("reads the code from the first member of an AggregateError (happy-eyeballs connects)", () => {
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED ::1:443"), { code: "ECONNREFUSED" })], ""), {});
    const err = toCloudNetworkError("https://cloud.example.test/x", fetchFailed(aggregate));
    expect(err.message).toContain("connection refused (ECONNREFUSED)");
  });

  it("keeps an unknown code next to the cause's own message", () => {
    const err = toCloudNetworkError(
      "https://cloud.example.test/x",
      fetchFailed({ code: "ERR_TLS_CERT_ALTNAME_INVALID", message: "Hostname/IP does not match certificate's altnames" }),
    );
    expect(err.message).toBe(
      "Cannot reach Rotifer Cloud (https://cloud.example.test): Hostname/IP does not match certificate's altnames (ERR_TLS_CERT_ALTNAME_INVALID)",
    );
  });

  it("falls back to the cause's message when there is no code", () => {
    const err = toCloudNetworkError("https://cloud.example.test/x", fetchFailed(new Error("other side closed")));
    expect(err.message).toBe("Cannot reach Rotifer Cloud (https://cloud.example.test): other side closed");
    expect(err.code).toBeUndefined();
  });

  it("keeps the original error as its cause", () => {
    const original = fetchFailed({ code: "ECONNRESET" });
    expect(toCloudNetworkError("https://cloud.example.test/x", original).cause).toBe(original);
  });

  it("keeps a URL it cannot parse as the endpoint", () => {
    const err = toCloudNetworkError("not a url", fetchFailed({ code: "ECONNRESET" }));
    expect(err.endpoint).toBe("not a url");
    expect(err.message).toBe("Cannot reach Rotifer Cloud (not a url): connection reset (ECONNRESET)");
  });
});

describe("registry calls", () => {
  afterEach(() => vi.restoreAllMocks());

  it("turn a network failure into a CloudNetworkError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(fetchFailed({ code: "ECONNREFUSED" }));
    await expect(listGeneVersions("alice", "gene")).rejects.toMatchObject({
      name: "CloudNetworkError",
      code: "ECONNREFUSED",
    });
  });

  it("let aborts and timeouts through unchanged, for callers that handle them", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    await expect(listGeneVersions("alice", "gene")).rejects.toBe(timeout);
  });
});
