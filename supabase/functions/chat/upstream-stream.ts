// Consumes an OpenAI-compatible chat-completions SSE stream and reports how
// it ended. The transport closing is NOT a completion signal: a generation
// only counts as complete when the protocol says so (finish_reason=stop).
// Judging by stream close alone is what let a half answer masquerade as a
// finished one and get cached (2026-08-29 incident).

export interface UpstreamResult {
  fullResponse: string;
  /** Last non-null finish_reason the stream carried, if any. */
  finishReason: string | null;
  /** Whether the terminating "data: [DONE]" marker arrived. */
  sawDoneMarker: boolean;
}

/**
 * A generation is complete only when the model itself said it stopped.
 * finish_reason=length means the token cap cut it off — the transport ended
 * cleanly but the answer is truncated, so it must not be cached either.
 */
export function isCompleteGeneration(result: UpstreamResult): boolean {
  return result.finishReason === "stop";
}

export async function consumeUpstreamStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<UpstreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullResponse = "";
  let finishReason: string | null = null;
  let sawDoneMarker = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        sawDoneMarker = true;
        continue;
      }

      try {
        const event = JSON.parse(data);
        const choice = event.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          fullResponse += delta;
          onDelta(delta);
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  return { fullResponse, finishReason, sawDoneMarker };
}
