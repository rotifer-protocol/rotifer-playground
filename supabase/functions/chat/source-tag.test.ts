import { assertEquals } from "jsr:@std/assert@1";
import { resolveAnalyticsSource } from "./source-tag.ts";

// Fixture-must-express-the-failure check for this suite: every assertion
// below is on resolveAnalyticsSource's actual return value against a real
// Request object (not a mocked req shape) — reverting resolveAnalyticsSource
// to `return "user"` unconditionally fails the "golden-qa" cases, and
// reverting the header name check to a typo fails the same cases while
// leaving the no-header case green, which is the two ways this tagging can
// silently regress into "everything looks like a real user again".

function req(headers?: Record<string, string>): Request {
  return new Request("https://example.test/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ question: "test" }),
  });
}

Deno.test("resolveAnalyticsSource: no header defaults to user (real rotifer.dev widget sends none)", () => {
  assertEquals(resolveAnalyticsSource(req()), "user");
});

Deno.test("resolveAnalyticsSource: X-Rotifer-Client: golden-qa is recognized", () => {
  assertEquals(resolveAnalyticsSource(req({ "X-Rotifer-Client": "golden-qa" })), "golden-qa");
});

Deno.test("resolveAnalyticsSource: header lookup is case-insensitive on the name (Fetch API Headers behavior)", () => {
  assertEquals(resolveAnalyticsSource(req({ "x-rotifer-client": "golden-qa" })), "golden-qa");
});

Deno.test("resolveAnalyticsSource: unrecognized header value falls back to user, not golden-qa", () => {
  assertEquals(resolveAnalyticsSource(req({ "X-Rotifer-Client": "something-else" })), "user");
});

// Wire-format contract check: the calling side lives in a separate codebase,
// so this test cannot stand up both halves at once. What it can do is pin the
// literal header name and value this side accepts, so a rename here fails
// loudly instead of silently drifting from what the client actually sends.
// The caller's side has the mirror of this assertion, checked against this
// file's real source.
Deno.test("resolveAnalyticsSource: literal contract the calling client must match", () => {
  const HEADER_NAME = "X-Rotifer-Client";
  const HEADER_VALUE = "golden-qa";
  assertEquals(resolveAnalyticsSource(req({ [HEADER_NAME]: HEADER_VALUE })), "golden-qa");
});
