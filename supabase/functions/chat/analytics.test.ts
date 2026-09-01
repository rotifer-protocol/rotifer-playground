import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

/**
 * recordAnalytics discards nothing silently.
 *
 * supabase-js resolves with `{ error }` instead of throwing, so the
 * function's try/catch never sees a rejected insert. Before this check, a
 * schema mismatch — this function deployed ahead of the migration adding a
 * column it writes — would stop recording ALL chat traffic with no log line
 * at all, and the admin dashboard would show a flat line that looks like
 * "nobody asked anything" rather than "the writer is broken". Verified
 * against a real postgres 2026-08-31: inserting an undeclared column errors
 * rather than being ignored.
 *
 * These are source-level assertions rather than a live call: recordAnalytics
 * builds its own Supabase client from env inside the function body, so there
 * is no seam to inject a fake through without restructuring it, and a real
 * insert needs a real database. The DB half of this behaviour is covered by
 * the migration replay; what can regress here is the code dropping the error
 * check again, which is exactly what these read for.
 */

const src = await Deno.readTextFile(new URL("./analytics.ts", import.meta.url));

Deno.test("recordAnalytics captures the insert's error instead of discarding it", () => {
  const insertIdx = src.indexOf('.from("chat_analytics").insert(');
  if (insertIdx === -1) throw new Error("chat_analytics insert not found in analytics.ts");

  // The insert's result must be destructured, not thrown away.
  const beforeInsert = src.slice(Math.max(0, insertIdx - 120), insertIdx);
  assertStringIncludes(
    beforeInsert,
    "{ error }",
    "the chat_analytics insert result is discarded again — a rejected write would vanish silently",
  );
});

Deno.test("recordAnalytics logs when the insert is rejected", () => {
  assertStringIncludes(
    src,
    "[analytics] Insert rejected:",
    "the rejected-insert log line is gone — failures would be invisible",
  );
  // The log has to be guarded by the error, not fired unconditionally.
  assertStringIncludes(src, "if (error)");
});

Deno.test("recordAnalytics writes the source tag it was handed", () => {
  // The whole point of the tag: if the insert stops carrying `source`, every
  // row falls back to the column default 'user' and CI traffic is counted as
  // real users again — the exact bug this work fixes, silently restored.
  assertStringIncludes(
    src,
    "source: event.source",
    "the source tag is no longer written — CI traffic would default to 'user'",
  );
});

Deno.test("AnalyticsEvent requires a source (no implicit default at the call site)", () => {
  // `source?:` would let a call site omit it and silently mislabel that path.
  const iface = src.slice(src.indexOf("interface AnalyticsEvent"), src.indexOf("export async function recordAnalytics"));
  assertEquals(iface.includes("source?:"), false, "source must not be optional");
  assertStringIncludes(iface, "source:");
});
