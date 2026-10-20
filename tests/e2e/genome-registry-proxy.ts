import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A read-only window onto the real Rotifer Cloud for e2e tests.
 *
 * The CLI is pointed at this proxy (ROTIFER_CLOUD_ENDPOINT). Reads — every GET,
 * and the read-only leaderboard RPC — go to the real Registry unchanged, so the
 * tests exercise the real wire format and real data. `track_download` is the one
 * write an install makes; it is answered here and recorded, never forwarded, so
 * the tests can assert it happened without touching production counts. Any
 * other write is refused with 403 and recorded as blocked, which fails the test.
 */
export const UPSTREAM = "https://cloud.rotifer.dev";

const READ_ONLY_RPCS = new Set(["/rest/v1/rpc/get_arena_leaderboard"]);
const TRACK_DOWNLOAD = "/rest/v1/rpc/track_download";

export interface RegistryProxy {
  endpoint: string;
  /** Request bodies of the `track_download` calls the CLI made. */
  trackedDownloads: Array<{ p_gene_id?: string; p_source?: string }>;
  /** Writes the proxy refused: "METHOD path". Must stay empty. */
  blockedWrites: string[];
  /** Every request seen: "METHOD path" (query stripped). */
  requests: string[];
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startRegistryProxy(): Promise<RegistryProxy> {
  const trackedDownloads: RegistryProxy["trackedDownloads"] = [];
  const blockedWrites: string[] = [];
  const requests: string[] = [];

  const server: Server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    requests.push(`${method} ${path}`);
    const body = await readBody(req);

    if (method === "POST" && path === TRACK_DOWNLOAD) {
      try {
        trackedDownloads.push(JSON.parse(body.toString("utf-8")));
      } catch {
        trackedDownloads.push({});
      }
      res.writeHead(204).end();
      return;
    }

    const isRead = method === "GET" || method === "HEAD" || (method === "POST" && READ_ONLY_RPCS.has(path));
    if (!isRead) {
      blockedWrites.push(`${method} ${path}`);
      res.writeHead(403, { "content-type": "application/json" }).end('{"message":"write blocked by test proxy"}');
      return;
    }

    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "connection", "content-length", "accept-encoding"].includes(k)) {
          headers[k] = v;
        }
      }
      const upstream = await fetch(UPSTREAM + url, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
      });
      const out = Buffer.from(await upstream.arrayBuffer());
      const outHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) outHeaders[k] = v;
      });
      res.writeHead(upstream.status, outHeaders).end(out);
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain" }).end(`proxy upstream error: ${(err as Error).message}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    trackedDownloads,
    blockedWrites,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
