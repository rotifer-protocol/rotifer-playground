import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClawHubError,
  InvalidSkillRef,
  fetchClawHubCandidates,
  fetchClawHubInfo,
  fetchClawHubPackage,
  parseSkillRef,
} from "../../src/utils/clawhub-client.js";

/**
 * Naming the publisher of a ClawHub skill (#625): `@owner/slug`, as ClawHub
 * writes it, sent as `ownerHandle`. The 409 answers are recorded from the real
 * ClawHub (tests/fixtures/clawhub/), publishers renamed.
 */

const FIXTURE = join(__dirname, "../fixtures/clawhub");
const AMBIGUOUS_TEXT = readFileSync(join(FIXTURE, "ambiguous-409.txt"), "utf-8");
const AMBIGUOUS_JSON = readFileSync(join(FIXTURE, "ambiguous-409-matches.json"), "utf-8");
const INFO = readFileSync(join(FIXTURE, "info.json"), "utf-8");
const api = "https://clawhub.test/api/skill";

/** A fetch that answers by URL and records every URL asked for. */
function routed(route: (url: string) => Response): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  return {
    fetchImpl: (async (url: string) => {
      seen.push(url);
      return route(url);
    }) as unknown as typeof fetch,
    seen,
  };
}

describe("parseSkillRef", () => {
  it("takes a slug, or @owner/slug", () => {
    expect(parseSkillRef("grilling")).toEqual({ slug: "grilling" });
    expect(parseSkillRef("@alice-demo/grilling")).toEqual({ slug: "grilling", ownerHandle: "alice-demo" });
  });

  it.each(["alice-demo/grilling", "@alice-demo", "@/grilling", "@a/b/c", "a b", "", "../x"])(
    "refuses %j instead of guessing",
    (ref) => {
      let thrown: unknown;
      try {
        parseSkillRef(ref);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InvalidSkillRef);
      expect((thrown as Error).message).toContain("@owner/slug");
    },
  );
});

describe("ownerHandle on the request", () => {
  it("is sent to both endpoints when a publisher is named, and URL-encoded", async () => {
    const f = routed((url) =>
      url.includes("/download") ? new Response("zip") : new Response(INFO, { headers: { "content-type": "application/json" } }),
    );
    await fetchClawHubInfo("grilling", { api, ownerHandle: "alice demo", fetchImpl: f.fetchImpl });
    await fetchClawHubPackage("grilling", { download: "https://clawhub.test/download", ownerHandle: "alice-demo", fetchImpl: f.fetchImpl });
    expect(f.seen).toEqual([
      "https://clawhub.test/api/skill?slug=grilling&ownerHandle=alice%20demo",
      "https://clawhub.test/download?slug=grilling&ownerHandle=alice-demo",
    ]);
  });

  it("is left out when no publisher is named", async () => {
    const f = routed(() => new Response(INFO, { headers: { "content-type": "application/json" } }));
    await fetchClawHubInfo("grilling", { api, fetchImpl: f.fetchImpl });
    expect(f.seen).toEqual(["https://clawhub.test/api/skill?slug=grilling"]);
  });
});

describe("a slug more than one publisher uses (HTTP 409)", () => {
  it("is 'ambiguous' at once, not retried, and carries the publishers ClawHub lists", async () => {
    const f = routed((url) =>
      url.includes("/api/v1/skills/")
        ? new Response(AMBIGUOUS_JSON, { status: 409, headers: { "content-type": "application/json" } })
        : new Response(AMBIGUOUS_TEXT, { status: 409, headers: { "content-type": "text/plain" } }),
    );
    const err = await fetchClawHubInfo("grilling", { api, retryDelaysMs: [0], fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ClawHubError);
    expect(err).toMatchObject({ kind: "ambiguous", status: 409, attempts: 1 });
    expect(err.message).toBe("is used by more than one publisher (HTTP 409)");
    expect(err.candidates).toEqual(["@alice-demo/grilling", "@bob-demo/grilling"]);
    expect(f.seen).toEqual(["https://clawhub.test/api/skill?slug=grilling", "https://clawhub.test/api/v1/skills/grilling"]);
  });

  it("the download endpoint's 409 is 'ambiguous' too", async () => {
    const f = routed(() => new Response(AMBIGUOUS_TEXT, { status: 409 }));
    const err = await fetchClawHubPackage("grilling", { download: "https://clawhub.test/download", fetchImpl: f.fetchImpl }).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ kind: "ambiguous", status: 409, attempts: 1 });
  });
});

describe("fetchClawHubCandidates", () => {
  it("is empty when the list cannot be had: an error, a page that is not JSON, or no list", async () => {
    for (const answer of [
      () => new Response("Server Error", { status: 500 }),
      () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response(JSON.stringify({ code: "AMBIGUOUS_SKILL_SLUG" }), { status: 409 }),
    ]) {
      const f = routed(answer);
      expect(await fetchClawHubCandidates("grilling", { api, fetchImpl: f.fetchImpl })).toEqual([]);
    }
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchClawHubCandidates("grilling", { api, fetchImpl: failing })).toEqual([]);
  });

  it("keeps only refs for this slug that are safe to print as a command", async () => {
    const matches = [
      { ref: "@alice-demo/grilling" },
      { ref: "@alice-demo/grilling" },
      { ref: "@bob-demo/other-skill" },
      { ref: "@x; rm -rf ~/grilling" },
      { ref: "@evil\u001b[31m/grilling" },
      { ref: 42 },
      null,
    ];
    const f = routed(() => new Response(JSON.stringify({ matches }), { status: 409 }));
    expect(await fetchClawHubCandidates("grilling", { api, fetchImpl: f.fetchImpl })).toEqual(["@alice-demo/grilling"]);
  });

  it("is not looked up for an endpoint it cannot place the list next to", async () => {
    const f = routed(() => new Response(AMBIGUOUS_JSON, { status: 409 }));
    expect(await fetchClawHubCandidates("grilling", { api: "https://mirror.test/skill-info", fetchImpl: f.fetchImpl })).toEqual([]);
    expect(f.seen).toEqual([]);
  });
});
