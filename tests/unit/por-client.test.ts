/**
 * The issuing client (ADR-300 revision 2): what it sends, what it refuses and
 * how each failure reads. The real function is exercised by tests/por-e2e/.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asPorError,
  errorFromResponse,
  isPorCapable,
  obtainCertificate,
  porFunctionUrl,
  PorError,
  type PorCapableNode,
  type PorClientDeps,
} from "../../src/utils/por-client.js";

const URL_FN = "http://127.0.0.1:54321/functions/v1/node-attestation";
const JWT = "SECRET.SESSION.JWT";
const USER = "00000000-0000-4000-8000-000000000001";
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const IAT = 1_800_000_000;
const SEVEN_DAYS = 7 * 24 * 3600;

interface Call {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

function node(peerId = "12D3KooWMe"): PorCapableNode & { signed: unknown[][] } {
  const signed: unknown[][] = [];
  return {
    signed,
    peerId: () => peerId,
    signPorChallenge: (...args) => {
      signed.push(args);
      return { publicKey: "PUBKEY", signature: "SIGNATURE" };
    },
    setAttestation: () => {},
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function service(over: { challenge?: Record<string, unknown>; issue?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return url.endsWith("/challenge")
      ? json(200, { nonce: NONCE, aud: URL_FN, challengeExp: IAT + 60, ...over.challenge })
      : json(200, { token: "a.b.c", peerId: "12D3KooWMe", iat: IAT, exp: IAT + SEVEN_DAYS, ...over.issue });
  });
  const deps: PorClientDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    session: async () => ({ jwt: JWT, userId: USER }),
    functionUrl: () => URL_FN,
  };
  return { calls, deps, fetchFn };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as PorError).code;
  }
  return "no error";
}

describe("obtainCertificate", () => {
  it("runs challenge then issue, handing the node only the challenge's four fields", async () => {
    const { calls, deps } = service();
    const n = node();
    const cert = await obtainCertificate(n, deps);
    expect(calls.map((c) => c.url)).toEqual([`${URL_FN}/challenge`, `${URL_FN}/issue`]);
    expect(calls[0].auth).toBe(`Bearer ${JWT}`);
    expect(calls[0].body).toEqual({});
    expect(n.signed).toEqual([[URL_FN, USER, NONCE, IAT + 60]]);
    expect(calls[1].body).toEqual({ publicKey: "PUBKEY", signature: "SIGNATURE", nonce: NONCE, challengeExp: IAT + 60 });
    expect(cert).toEqual({ token: "a.b.c", peerId: "12D3KooWMe", iat: IAT, exp: IAT + SEVEN_DAYS });
  });

  it("refuses a challenge for another address and signs nothing", async () => {
    const { deps, calls } = service({ challenge: { aud: "https://elsewhere.example/functions/v1/node-attestation" } });
    const n = node();
    expect(await codeOf(obtainCertificate(n, deps))).toBe("POR_AUD_MISMATCH");
    expect(n.signed).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("says which aud it expected and which it got", async () => {
    const { deps } = service({ challenge: { aud: "https://elsewhere.example/fn\u001b[2J" } });
    const err = (await obtainCertificate(node(), deps).catch((e: Error) => e)) as PorError;
    expect(err.message).toContain(`Expected aud: "${URL_FN}"`);
    expect(err.message).toContain("https://elsewhere.example/fn");
    expect(err.message).not.toContain("\u001b");
    expect(err.fix).toContain("ROTIFER_CLOUD_ENDPOINT");
  });

  it("refuses an aud that differs only by a trailing slash", async () => {
    const { deps } = service({ challenge: { aud: `${URL_FN}/` } });
    expect(await codeOf(obtainCertificate(node(), deps))).toBe("POR_AUD_MISMATCH");
  });

  it.each([
    ["no nonce", { nonce: 7 }],
    ["no aud", { aud: null }],
    ["an expiry that is not a whole number", { challengeExp: 1.5 }],
  ])("refuses a challenge with %s", async (_what, challenge) => {
    const { deps } = service({ challenge });
    expect(await codeOf(obtainCertificate(node(), deps))).toBe("POR_BAD_RESPONSE");
  });

  it.each([
    ["for another node", { peerId: "12D3KooWOther" }],
    ["with no token", { token: 7 }],
    ["longer than 7 days", { exp: IAT + SEVEN_DAYS + 1 }],
    ["that ends before it starts", { exp: IAT }],
  ])("refuses a certificate %s", async (_what, issue) => {
    const { deps } = service({ issue });
    expect(await codeOf(obtainCertificate(node(), deps))).toBe("POR_BAD_RESPONSE");
  });

  it("accepts a certificate of exactly 7 days", async () => {
    const { deps } = service();
    expect((await obtainCertificate(node(), deps)).exp - IAT).toBe(SEVEN_DAYS);
  });

  it("reports a node that refuses the fields without passing its message on", async () => {
    const { deps } = service();
    const n = node();
    n.signPorChallenge = () => {
      throw new Error(`bad field ${JWT}`);
    };
    const err = await obtainCertificate(n, deps).catch((e: Error) => e);
    expect((err as PorError).code).toBe("POR_BAD_RESPONSE");
    expect(String((err as PorError).message)).not.toContain(JWT);
  });

  it("calls an unreachable service unreachable, without the transport's text", async () => {
    const { deps } = service();
    deps.fetch = (async () => {
      throw new Error(`connect failed with ${JWT}`);
    }) as typeof fetch;
    const err = (await obtainCertificate(node(), deps).catch((e: Error) => e)) as PorError;
    expect(err.code).toBe("POR_UNREACHABLE");
    expect(`${err.message} ${err.fix}`).not.toContain(JWT);
  });
});

describe("what a refusal means", () => {
  it.each([
    [409, "POR_QUOTA_EXCEEDED", "POR_QUOTA_EXCEEDED", "3 nodes"],
    [409, "POR_RENEWAL_TOO_EARLY", "POR_RENEWAL_TOO_EARLY", "24 hours"],
    [401, "POR_UNAUTHENTICATED", "POR_SESSION_EXPIRED", "rotifer login"],
    [503, "POR_NOT_CONFIGURED", "POR_SERVICE_NOT_OPEN", "not open yet"],
    [409, "POR_PEER_BOUND_ELSEWHERE", "POR_PEER_BOUND_ELSEWHERE", "another account"],
    [409, "POR_PEER_REVOKED", "POR_PEER_REVOKED", "revoked"],
    [403, "POR_ACCOUNT_CLOSED", "POR_ACCOUNT_CLOSED", "no longer"],
    [429, "POR_RATE_LIMITED", "POR_RATE_LIMITED", "Too many"],
  ])("%i %s reads as %s", (status, serverCode, code, words) => {
    const err = errorFromResponse(status, serverCode);
    expect(err.code).toBe(code);
    expect(`${err.message} ${err.fix}`).toContain(words);
    expect(err.fix.length).toBeGreaterThan(0);
  });

  it("says the service is not open when the function does not exist", () => {
    expect(errorFromResponse(404, undefined).code).toBe("POR_SERVICE_NOT_OPEN");
    expect(errorFromResponse(404, "NOT_FOUND").code).toBe("POR_SERVICE_NOT_OPEN");
  });

  it("does not take a gateway's 401 for anything but a session problem", () => {
    expect(errorFromResponse(401, undefined).code).toBe("POR_SESSION_EXPIRED");
  });

  it("ignores codes it does not know, including ones made to look like properties", () => {
    expect(errorFromResponse(500, "POR_SOMETHING_NEW").code).toBe("POR_SERVICE_ERROR");
    expect(errorFromResponse(500, "POR_constructor").code).toBe("POR_SERVICE_ERROR");
    expect(errorFromResponse(500, "toString").code).toBe("POR_SERVICE_ERROR");
    expect(errorFromResponse(500, 42).code).toBe("POR_SERVICE_ERROR");
  });

  it("loses the text of anything unexpected", () => {
    const err = asPorError(new Error(`boom ${JWT}`));
    expect(err.code).toBe("POR_CLIENT_ERROR");
    expect(err.message).not.toContain(JWT);
  });
});

describe("which address is called", () => {
  const CLOUD = "https://cloud.rotifer.dev";

  it("is the function under the Cloud endpoint, byte for byte", () => {
    expect(porFunctionUrl(CLOUD)).toBe("https://cloud.rotifer.dev/functions/v1/node-attestation");
  });

  it("ignores trailing slashes on the endpoint, and has none itself", () => {
    expect(porFunctionUrl(`${CLOUD}/`)).toBe("https://cloud.rotifer.dev/functions/v1/node-attestation");
    expect(porFunctionUrl(`${CLOUD}//`)).toBe("https://cloud.rotifer.dev/functions/v1/node-attestation");
  });

  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321", "https://staging.example"])(
    "follows an endpoint of %s",
    (endpoint) => {
      expect(porFunctionUrl(endpoint)).toBe(`${endpoint}/functions/v1/node-attestation`);
    },
  );

  it.each(["http://example.com", "http://127.0.0.1.evil.example", "ftp://127.0.0.1", "not a url"])(
    "will not send a session to %s",
    (endpoint) => {
      expect(() => porFunctionUrl(endpoint)).toThrow(PorError);
    },
  );

  it("the default path reads the configured endpoint", async () => {
    vi.resetModules();
    vi.stubEnv("ROTIFER_CLOUD_ENDPOINT", "http://127.0.0.1:54321");
    vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "por-endpoint-")));
    const { defaultPorClientDeps } = await import("../../src/utils/por-client.js");
    expect(defaultPorClientDeps.functionUrl()).toBe("http://127.0.0.1:54321/functions/v1/node-attestation");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("older addons", () => {
  it("are recognised by the missing methods", () => {
    expect(isPorCapable({ peerId: () => "p" })).toBe(false);
    expect(isPorCapable({ peerId: () => "p", signPorChallenge: () => ({}) })).toBe(false);
    expect(isPorCapable(null)).toBe(false);
    expect(isPorCapable(node())).toBe(true);
  });
});

describe("currentSession", () => {
  let home: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  async function sessionWith(credentials?: Record<string, unknown>): Promise<string> {
    home = mkdtempSync(join(tmpdir(), "por-session-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    if (credentials) {
      mkdirSync(join(home, ".rotifer"));
      writeFileSync(join(home, ".rotifer", "credentials.json"), JSON.stringify(credentials));
    }
    const { currentSession } = await import("../../src/utils/por-client.js");
    return currentSession().then(
      (s) => `${s.jwt}|${s.userId}`,
      (e: PorError) => e.code,
    );
  }

  it("says not signed in when there are no credentials", async () => {
    expect(await sessionWith()).toBe("POR_NOT_LOGGED_IN");
  });

  it("says expired when the sign-in has lapsed and cannot be refreshed", async () => {
    expect(await sessionWith({ access_token: "x", expires_at: 1, provider: "github", user: { id: USER } })).toBe(
      "POR_SESSION_EXPIRED",
    );
  });

  it("uses a live sign-in", async () => {
    const live = { access_token: "tok", expires_at: Date.now() + 60_000, provider: "github", user: { id: USER } };
    expect(await sessionWith(live)).toBe(`tok|${USER}`);
  });
});
