/**
 * BEFORE: MCP Tool — URL Fetcher
 *
 * A typical MCP Tool that fetches web page content from a URL.
 * This file shows the original MCP Tool format before migration.
 */

import { z } from "zod";

export const urlFetcherTool = {
  name: "url_fetcher",
  description: "Fetch the text content of a web page",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
    timeout: z.number().optional().default(5000).describe("Timeout in milliseconds"),
  }),
  handler: async ({ url, timeout }: { url: string; timeout: number }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();

      return {
        content: text.slice(0, 5000),
        statusCode: response.status,
        contentType: response.headers.get("content-type") || "unknown",
        truncated: text.length > 5000,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
