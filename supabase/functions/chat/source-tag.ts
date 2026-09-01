/**
 * Tags each chat request so its analytics row records where the request came
 * from — a real site visitor, or the documentation QA suite that runs in CI.
 *
 * Both call this same production endpoint, so until this tag existed their
 * rows in chat_analytics were indistinguishable and the ops dashboard counted
 * scheduled test runs as product usage (the daily run alone accounted for the
 * bulk of the 30-day request count).
 *
 * Only the QA suite is expected to send the header; every other caller,
 * present or future, falls through to "user". Verified 2026-08-31 that the
 * QA suite is the only known automated caller of this endpoint. The client
 * side sends this exact header name and value — renaming either half
 * silently returns the dashboard to blended numbers, so both are pinned by
 * tests on each side.
 *
 * Kept in its own module rather than inline in index.ts so tests can import
 * it without triggering index.ts's top-level Deno.serve().
 */
export function resolveAnalyticsSource(req: Request): "user" | "golden-qa" {
  return req.headers.get("x-rotifer-client") === "golden-qa" ? "golden-qa" : "user";
}
