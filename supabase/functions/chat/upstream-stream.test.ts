// Regression tests for the truncated-generation caching bug (2026-08-29).
//
// Production evidence: the upstream LLM stream died mid-generation, the
// consumer treated "stream closed" as "generation finished", and a 256-char
// half answer was cached for two hours ("F(g) 乘法模型" ZH answer cut at
//「**乘法结构，」, missing the required 「零」). Completion must be judged by
// the wire protocol's own completion signals (finish_reason / [DONE]), not
// by the transport closing.
//
// Chunks below are genuine OpenAI-compatible chat-completions SSE bytes —
// the same wire format api.deepseek.com sends — per the wire-format
// contract rule: parsing tests must use the real format, not a paraphrase.

import { assertEquals } from "jsr:@std/assert";
import {
  consumeUpstreamStream,
  isCompleteGeneration,
  type UpstreamResult,
} from "./upstream-stream.ts";

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function delta(content: string): string {
  return sse({ choices: [{ delta: { content }, finish_reason: null }] });
}

const FINISH_STOP = sse({ choices: [{ delta: {}, finish_reason: "stop" }] });
const FINISH_LENGTH = sse({ choices: [{ delta: {}, finish_reason: "length" }] });
const DONE = "data: [DONE]\n\n";

function streamOfBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return streamOfBytes(parts.map((p) => enc.encode(p)));
}

async function consume(
  body: ReadableStream<Uint8Array>,
): Promise<{ result: UpstreamResult; deltas: string[] }> {
  const deltas: string[] = [];
  const result = await consumeUpstreamStream(body, (t) => deltas.push(t));
  return { result, deltas };
}

Deno.test("complete generation: finish_reason=stop then [DONE] is cacheable", async () => {
  const { result, deltas } = await consume(
    streamOf(delta("乘法模型"), delta("——任何一项为零则整体为零。"), FINISH_STOP, DONE),
  );
  assertEquals(result.fullResponse, "乘法模型——任何一项为零则整体为零。");
  assertEquals(result.finishReason, "stop");
  assertEquals(result.sawDoneMarker, true);
  assertEquals(isCompleteGeneration(result), true);
  assertEquals(deltas, ["乘法模型", "——任何一项为零则整体为零。"]);
});

Deno.test("bug repro: stream closes mid-generation — not cacheable", async () => {
  // The upstream connection dies after two deltas: no finish_reason chunk,
  // no [DONE]. Before the fix this was indistinguishable from success and
  // the half answer went into response_cache.
  const { result } = await consume(
    streamOf(delta("关键特性：\n\n- **乘法结构，")),
  );
  assertEquals(result.fullResponse, "关键特性：\n\n- **乘法结构，");
  assertEquals(result.finishReason, null);
  assertEquals(result.sawDoneMarker, false);
  assertEquals(isCompleteGeneration(result), false);
});

Deno.test("finish_reason=length (token cap hit) — not cacheable", async () => {
  const { result } = await consume(
    streamOf(delta("truncated by max_tokens"), FINISH_LENGTH, DONE),
  );
  assertEquals(result.finishReason, "length");
  assertEquals(isCompleteGeneration(result), false);
});

Deno.test("[DONE] without any finish_reason — not cacheable", async () => {
  const { result } = await consume(streamOf(delta("partial"), DONE));
  assertEquals(result.sawDoneMarker, true);
  assertEquals(result.finishReason, null);
  assertEquals(isCompleteGeneration(result), false);
});

Deno.test("multi-byte UTF-8 split across transport chunks reassembles", async () => {
  // 「零」 is three UTF-8 bytes; split the whole SSE line mid-character the
  // way a TCP boundary can. The streaming decoder must reassemble it.
  const enc = new TextEncoder();
  const bytes = enc.encode(delta("为零") + FINISH_STOP + DONE);
  const cut = 12; // inside the multi-byte payload of the first data line
  const { result } = await consume(
    streamOfBytes([bytes.slice(0, cut), bytes.slice(cut)]),
  );
  assertEquals(result.fullResponse, "为零");
  assertEquals(isCompleteGeneration(result), true);
});

Deno.test("unparseable lines are skipped, later deltas still collected", async () => {
  const { result, deltas } = await consume(
    streamOf(delta("a"), "data: {not json}\n\n", delta("b"), FINISH_STOP, DONE),
  );
  assertEquals(result.fullResponse, "ab");
  assertEquals(deltas, ["a", "b"]);
  assertEquals(isCompleteGeneration(result), true);
});

Deno.test("index.ts wiring: setCachedResponse is guarded by isCompleteGeneration", async () => {
  // Source-text drift guard (repo pattern): the module can be perfect and
  // the bug still present if index.ts caches unconditionally. Assert the
  // guard sits between the two calls.
  const src = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const guard = src.indexOf("isCompleteGeneration(");
  const cache = src.indexOf("setCachedResponse(");
  if (guard === -1) throw new Error("index.ts no longer calls isCompleteGeneration()");
  if (cache === -1) throw new Error("index.ts no longer calls setCachedResponse()");
  if (guard > cache) {
    throw new Error(
      "setCachedResponse() appears before the isCompleteGeneration() guard — truncated generations may be cached again",
    );
  }
});
