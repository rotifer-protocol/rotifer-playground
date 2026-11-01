import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";

/**
 * A failure on purpose, for checking what .github/workflows/live-checks.yml
 * files when a lane fails (its `simulate_failure` input). ROTIFER_LIVE_SIMULATE:
 *
 * - unset: the real service;
 * - "http-500": a local server answering every request with HTTP 500, the way
 *   ClawHub's backend answers when it fails;
 * - "refused": a local port nothing listens on, the way an outage looks.
 *
 * The live suites point the CLI at it through the endpoint overrides the CLI
 * already documents (ROTIFER_CLAWHUB_API_URL / _DOWNLOAD_URL,
 * ROTIFER_CLOUD_ENDPOINT). No CLI code knows about this, so the lane fails on
 * the CLI's real error output, which is what the issue step quotes.
 */
export interface SimulatedService {
  mode: string;
  url: string;
  close: () => Promise<void>;
}

export async function simulatedService(): Promise<SimulatedService | null> {
  const mode = (process.env.ROTIFER_LIVE_SIMULATE ?? "").trim();
  if (mode === "") return null;

  if (mode === "http-500") {
    const server = createServer((_req, res) => {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ code: "[Request ID: simulated-failure] Server Error" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      mode,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  if (mode === "refused") {
    const probe = createTcpServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return { mode, url: `http://127.0.0.1:${port}`, close: async () => {} };
  }

  throw new Error(`ROTIFER_LIVE_SIMULATE must be "http-500" or "refused", not "${mode}"`);
}

/** Printed at the start of a simulated run, so its failure is not mistaken for a real one. */
export function announceSimulation(sim: SimulatedService, service: string): void {
  console.warn(`SIMULATED FAILURE (ROTIFER_LIVE_SIMULATE=${sim.mode}): ${service} is replaced by ${sim.url}`);
}
