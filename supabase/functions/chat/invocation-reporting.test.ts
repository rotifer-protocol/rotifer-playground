/**
 * The chat endpoint must not report Gene invocations.
 *
 * index.ts used to call `log_gene_invocation` for four hardcoded Gene names
 * after every answer. Two separate things were wrong with that, and it is the
 * second one this test exists to prevent coming back:
 *
 *  1. It never worked. `log_gene_invocation` takes `p_gene_id UUID` and was
 *     handed the name string, so PostgREST rejected every call. The error went
 *     nowhere: supabase-js resolves with `{ error }` rather than throwing, so
 *     the trailing `.catch(() => {})` could not have caught it even in
 *     principle — the same trap analytics.ts documents at its own insert.
 *
 *  2. Making it work would have been worse than leaving it broken. chat does
 *     not execute those Genes. It performs retrieval plus one LLM call inline;
 *     the four names are display labels for the answer pipeline, which is why
 *     every one of them reports `ms: 0`. `gene_invocation_log` feeds
 *     `gene_contribution_metrics` (total_invocations / unique_callers /
 *     invocations_last_30d) — the §33.4 anti-manipulation reputation signal.
 *     All four names resolve to real published Genes owned by this project, so
 *     four rows per answer would have inflated the project's own Genes with
 *     traffic from the project's own website. The whole ledger held 14 rows
 *     when this was found; chat would have become nearly all of it.
 *
 * Nothing was lost by removing it. Chat usage is already recorded where it
 * belongs — `recordAnalytics` writes `chat_analytics`, and tags CI traffic
 * separately from real visitors. Per-Gene attribution is not chat's to report,
 * because chat runs no Genes.
 *
 * These are source-level checks because the invariant is that a call site does
 * *not* exist, which no amount of exercising the module can demonstrate. The
 * `deno test --allow-read=supabase/functions/chat` permission in ci.yml is
 * already scoped for exactly this; analytics.test.ts and upstream-stream.test.ts
 * use the same idiom.
 */

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("chat writes nothing to the Gene invocation ledger", () => {
  for (
    const forbidden of [
      "log_gene_invocation",
      "log_gene_invocation_v2",
      "gene_invocation_log",
    ]
  ) {
    if (src.includes(forbidden)) {
      throw new Error(
        `index.ts references ${forbidden}. chat executes no Genes, so it must ` +
          `not report invocations into the ledger that drives reputation — ` +
          `see the comment at the top of this file.`,
      );
    }
  }
});

Deno.test("chat holds no privileged key for the main project", () => {
  // The main project's secret key was read solely to perform the write above.
  // With the write gone the key has no consumer, so chat should not hold one:
  // an unused full-privilege credential in a public, unauthenticated endpoint
  // is blast radius with no upside.
  if (src.includes("MAIN_SECRET_KEY") || src.includes("SUPABASE_SERVICE_ROLE_KEY")) {
    throw new Error(
      "index.ts reads a privileged key for the main project. chat is a public " +
        "endpoint (verify_jwt = false) and has no remaining need for one.",
    );
  }
});

Deno.test("the answer pipeline is still labels, not executed Genes", () => {
  // The tripwire for premise (2): if chat ever really does execute Genes,
  // these steps stop reporting ms: 0, and whoever changes that has to come
  // back here and re-decide the ledger question rather than inheriting a "no"
  // that was only ever about labels.
  const start = src.indexOf("pipeline: [");
  if (start === -1) throw new Error("pipeline literal not found in index.ts");
  const end = src.indexOf("]", start);
  if (end === -1) throw new Error("pipeline literal is not terminated");
  const block = src.slice(start, end);

  const timings = [...block.matchAll(/ms:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (timings.length === 0) throw new Error("pipeline steps report no ms field");
  const executed = timings.filter((ms) => ms !== 0);
  if (executed.length > 0) {
    throw new Error(
      `pipeline reports non-zero timings (${executed.join(", ")}), so chat may ` +
        `now be executing Genes. Re-decide whether invocations should be ` +
        `reported before changing this test.`,
    );
  }
});
