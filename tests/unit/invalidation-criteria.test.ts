import { describe, expect, it } from "vitest";
import {
  hitsTestData,
  hitsNoPublishedArtifact,
  hitsAsyncExpressArtifact,
  judgeRow,
  findDrift,
  CRITERION_ORDER,
  type AuditInput,
} from "../../src/arena/invalidation-criteria.js";

/**
 * ADR-319 D2 replaces a curated drop-list with criteria anyone can re-run.
 * What these tests protect is less "the criteria are right" than "the criteria
 * cannot quietly become permissive": every case below is a way a row could slip
 * back onto the board — an unchecked artifact counted as clean, an unpublished
 * gene mistaken for a deleted one, a second reason silently dropped.
 */

function row(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    geneId: "11111111-1111-1111-1111-111111111111",
    domain: "util.text",
    gene: {
      name: "example",
      version: "1.0.0",
      fidelity: "Native",
      wasmPath: "owner/example/1.0.0/gene.ir.wasm",
      wasmSize: 1024,
    },
    evaluationMethod: "unknown-legacy",
    invalidatedAt: null,
    invalidationReason: null,
    ...overrides,
  };
}

const CLEAN_WASM = Buffer.from("var __gene = (() => { function express(input) { return {ok:true}; } })();");
const ASYNC_WASM = Buffer.from("var __gene = (() => { async function express(input) { return {ok:true}; } })();");
const ASSIGNED_ASYNC_WASM = Buffer.from("var __gene = (() => { const express = async (input) => ({ok:true}); })();");

describe("test-data", () => {
  it("fires on the arena row's declared domain", () => {
    expect(hitsTestData(row({ domain: "test" }))?.criterion).toBe("test-data");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(hitsTestData(row({ domain: " TEST " }))).not.toBeNull();
  });

  it("leaves a real domain alone", () => {
    expect(hitsTestData(row({ domain: "util.text" }))).toBeNull();
    expect(hitsTestData(row({ domain: null }))).toBeNull();
  });

  it("does not fire on a domain that merely contains 'test'", () => {
    expect(hitsTestData(row({ domain: "testing.harness" }))).toBeNull();
    expect(hitsTestData(row({ domain: "code.test-runner" }))).toBeNull();
  });
});

describe("no-published-artifact", () => {
  it("fires when a WASM-bearing fidelity has no artifact", () => {
    const hit = hitsNoPublishedArtifact(
      row({ gene: { name: "g", version: "1", fidelity: "Native", wasmPath: null, wasmSize: 0 } })
    );
    expect(hit?.criterion).toBe("no-published-artifact");
  });

  /**
   * The first version of this criterion held Hybrid to an artifact too, on the
   * reading that L-II "partially native execution" promises WASM. It does — in
   * the target design. But the Hybrid path that actually ships was chosen by
   * the v0.7 plan as an interim: Node.js with a gateway-wrapped fetch, no
   * WASM at all. Nine production rows are Hybrid-without-artifact, and every
   * one of them followed the toolchain. When the host-function path lands,
   * this test flips back — deliberately, with the reason next to it.
   */
  it("does not hold Hybrid to an artifact while the Node path is the shipping design", () => {
    expect(
      hitsNoPublishedArtifact(
        row({ gene: { name: "g", version: "1", fidelity: "Hybrid", wasmPath: null, wasmSize: 0 } })
      )
    ).toBeNull();
  });

  it("leaves Wrapped alone — it never promised an artifact", () => {
    expect(
      hitsNoPublishedArtifact(
        row({ gene: { name: "g", version: "1", fidelity: "Wrapped", wasmPath: null, wasmSize: 0 } })
      )
    ).toBeNull();
  });

  it("leaves a Native gene that does have an artifact alone", () => {
    expect(hitsNoPublishedArtifact(row())).toBeNull();
  });

  /**
   * The FK from arena_entries cascades on delete, so a row can never outlive
   * its gene. An unreadable gene means the author unpublished it — which
   * `rotifer unpublish` is being built to support. Invalidating on that would
   * punish a supported action.
   */
  it("does not fire on an unpublished gene", () => {
    expect(hitsNoPublishedArtifact(row({ gene: null }))).toBeNull();
  });
});

describe("async-express-artifact", () => {
  it("fires on the declaration form", () => {
    const hit = hitsAsyncExpressArtifact(row(), ASYNC_WASM);
    expect(hit?.criterion).toBe("async-express-artifact");
    expect(hit?.evidence).toContain("async function express");
  });

  /**
   * The Rust runtime refuses both shapes. A criteria engine that only knew the
   * declaration form would rank a gene the sandbox will not run.
   */
  it("fires on the assignment form too", () => {
    expect(hitsAsyncExpressArtifact(row(), ASSIGNED_ASYNC_WASM)?.criterion).toBe(
      "async-express-artifact"
    );
  });

  it("leaves a synchronous artifact alone", () => {
    expect(hitsAsyncExpressArtifact(row(), CLEAN_WASM)).toBeNull();
  });

  it("reports absence rather than firing when there are no bytes", () => {
    expect(hitsAsyncExpressArtifact(row(), null)).toBeNull();
    expect(hitsAsyncExpressArtifact(row(), new Uint8Array(0))).toBeNull();
  });

  it("survives arbitrary binary around the marker", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0xff, 0xfe]),
      ASYNC_WASM,
      Buffer.from([0xff, 0x00, 0x80]),
    ]);
    expect(hitsAsyncExpressArtifact(row(), buf)).not.toBeNull();
  });
});

describe("judgeRow", () => {
  it("reports the first criterion in the documented order and keeps the rest", () => {
    // A test-domain row whose gene also has no artifact: both fire.
    const v = judgeRow(
      row({
        domain: "test",
        gene: { name: "g", version: "1", fidelity: "Native", wasmPath: null, wasmSize: 0 },
      }),
      null,
      { artifactFetched: true }
    );
    expect(v.criterion).toBe("test-data");
    expect(v.allHits.map((h) => h.criterion)).toEqual(["test-data", "no-published-artifact"]);
  });

  it("orders hits by CRITERION_ORDER, not by discovery", () => {
    const v = judgeRow(row({ domain: "test" }), ASYNC_WASM, { artifactFetched: true });
    const positions = v.allHits.map((h) => CRITERION_ORDER.indexOf(h.criterion));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  /**
   * The failure this guards against: a run that skipped downloads reporting
   * "clean" for rows it never looked at. Unchecked is a third state, not a
   * flavour of clean.
   */
  it("marks a row unchecked when its artifact was not read", () => {
    const v = judgeRow(row(), null, { artifactFetched: false });
    expect(v.criterion).toBeNull();
    expect(v.artifactUnchecked).toBe(true);
  });

  it("does not mark a row unchecked when there was no artifact to read", () => {
    const v = judgeRow(
      row({ gene: { name: "g", version: "1", fidelity: "Wrapped", wasmPath: null, wasmSize: 0 } }),
      null,
      { artifactFetched: false }
    );
    expect(v.artifactUnchecked).toBe(false);
  });

  it("names an unpublished gene rather than showing a blank", () => {
    expect(judgeRow(row({ gene: null }), null, { artifactFetched: true }).geneName).toBe(
      "(unpublished)"
    );
  });
});

describe("findDrift", () => {
  const judge = (r: AuditInput, bytes: Uint8Array | null = null, fetched = true) =>
    judgeRow(r, bytes, { artifactFetched: fetched });

  it("reports nothing when criteria and board agree", () => {
    const clean = judge(row({ gene: { name: "g", version: "1", fidelity: "Wrapped", wasmPath: null, wasmSize: 0 } }));
    const marked = judge(
      row({ domain: "test", invalidatedAt: "2026-08-18T00:00:00Z", invalidationReason: "test-data" })
    );
    expect(findDrift([clean, marked])).toEqual([]);
  });

  it("reports 'missing' when the criteria fire but nothing was recorded", () => {
    const d = findDrift([judge(row({ domain: "test" }))]);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("missing");
  });

  /**
   * The one that matters most: an invalidation on the board that no criterion
   * reproduces is either a stale criterion or a hand edit — exactly what D6
   * forbids and what a curated drop-list would have hidden.
   */
  it("reports 'unreproducible' when the board invalidated a row no criterion catches", () => {
    const d = findDrift([
      judge(
        row({
          gene: { name: "g", version: "1", fidelity: "Wrapped", wasmPath: null, wasmSize: 0 },
          invalidatedAt: "2026-08-18T00:00:00Z",
          invalidationReason: "someone-said-so",
        })
      ),
    ]);
    expect(d[0].kind).toBe("unreproducible");
    expect(d[0].stored).toBe("someone-said-so");
  });

  it("reports 'reason-mismatch' when both agree it is invalid but disagree why", () => {
    const d = findDrift([
      judge(
        row({
          domain: "test",
          invalidatedAt: "2026-08-18T00:00:00Z",
          invalidationReason: "async-express-artifact",
        })
      ),
    ]);
    expect(d[0].kind).toBe("reason-mismatch");
    expect(d[0].computed).toBe("test-data");
  });

  /** A partial run cannot tell "no criterion fires" from "we did not look". */
  it("does not call an unchecked row unreproducible", () => {
    const d = findDrift([
      judge(
        row({ invalidatedAt: "2026-08-18T00:00:00Z", invalidationReason: "async-express-artifact" }),
        null,
        false
      ),
    ]);
    expect(d).toEqual([]);
  });
});
