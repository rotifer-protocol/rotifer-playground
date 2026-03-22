/**
 * BEFORE: MCP Tool — Text Summarizer
 *
 * A typical MCP Tool that summarizes text input.
 * This file shows the original MCP Tool format before migration.
 */

import { z } from "zod";

export const textSummarizerTool = {
  name: "text_summarizer",
  description: "Summarize a text passage into a concise summary",
  inputSchema: z.object({
    text: z.string().describe("The text to summarize"),
    maxLength: z.number().optional().default(100).describe("Max summary length in characters"),
  }),
  handler: async ({ text, maxLength }: { text: string; maxLength: number }) => {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const summary = sentences.slice(0, 3).join(". ").trim();
    const truncated = summary.length > maxLength
      ? summary.slice(0, maxLength) + "..."
      : summary;

    return {
      summary: truncated,
      originalLength: text.length,
      summaryLength: truncated.length,
      compressionRatio: +(truncated.length / text.length).toFixed(2),
    };
  },
};
