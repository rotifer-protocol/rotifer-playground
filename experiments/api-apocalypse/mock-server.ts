/**
 * API Apocalypse — Chaos Mock Server
 *
 * 3 weather data source endpoints that change behavior over time.
 * Demonstrates the kind of API instability that Rotifer's
 * evolutionary failover is designed to handle.
 *
 * Usage: npx tsx experiments/api-apocalypse/mock-server.ts
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = 9876;

// --- Temperature simulation (slight random drift) ---

let baseTemp = 23.5;

function currentTemp(): number {
  baseTemp += (Math.random() - 0.5) * 0.6;
  return Math.round(baseTemp * 10) / 10;
}

// --- Phase management ---

interface Phase {
  startOffsetMs: number;
  label: string;
}

const PHASES: Phase[] = [
  { startOffsetMs: 0, label: "normal" },
  { startOffsetMs: 30_000, label: "source-a-restructured" },
  { startOffsetMs: 60_000, label: "source-b-restructured" },
  { startOffsetMs: 90_000, label: "source-c-reordered" },
  { startOffsetMs: 120_000, label: "source-a-ratelimit" },
  { startOffsetMs: 150_000, label: "source-b-offline" },
];

let serverStartTime = 0;

function currentPhaseIndex(): number {
  const elapsed = Date.now() - serverStartTime;
  let idx = 0;
  for (let i = PHASES.length - 1; i >= 0; i--) {
    if (elapsed >= PHASES[i].startOffsetMs) {
      idx = i;
      break;
    }
  }
  return idx;
}

function isPhaseActive(phaseIndex: number): boolean {
  return currentPhaseIndex() >= phaseIndex;
}

// --- Source A: JSON weather endpoint ---

function handleSourceA(_req: IncomingMessage, res: ServerResponse): void {
  if (isPhaseActive(4)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too Many Requests", retryAfter: 60 }));
    return;
  }

  const temp = currentTemp();

  if (isPhaseActive(1)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        weather: { temp_celsius: temp, location: "Beijing" },
      })
    );
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        temperature: temp,
        city: "Beijing",
        unit: "celsius",
      })
    );
  }
}

// --- Source B: XML weather endpoint ---

function handleSourceB(_req: IncomingMessage, res: ServerResponse): void {
  if (isPhaseActive(5)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Service Unavailable");
    return;
  }

  const temp = currentTemp();

  if (isPhaseActive(2)) {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(`<data><temp city="Beijing" celsius="${temp}"/></data>`);
  } else {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(
      `<weather><city>Beijing</city><temperature>${temp}</temperature><unit>celsius</unit></weather>`
    );
  }
}

// --- Source C: CSV weather endpoint ---

function handleSourceC(_req: IncomingMessage, res: ServerResponse): void {
  const temp = currentTemp();

  if (isPhaseActive(3)) {
    res.writeHead(200, { "Content-Type": "text/csv" });
    res.end(`location,unit,value\nBeijing,celsius,${temp}`);
  } else {
    res.writeHead(200, { "Content-Type": "text/csv" });
    res.end(`city,temperature,unit\nBeijing,${temp},celsius`);
  }
}

// --- Status endpoint ---

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  const elapsed = Date.now() - serverStartTime;
  const phase = PHASES[currentPhaseIndex()];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      elapsedMs: elapsed,
      elapsedSec: Math.round(elapsed / 1000),
      currentPhase: phase.label,
      phaseIndex: currentPhaseIndex(),
      phases: PHASES.map((p, i) => ({
        ...p,
        active: i <= currentPhaseIndex(),
        startsIn: Math.max(0, p.startOffsetMs - elapsed),
      })),
    })
  );
}

// --- Server ---

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/source-a") return handleSourceA(req, res);
  if (url === "/source-b") return handleSourceB(req, res);
  if (url === "/source-c") return handleSourceC(req, res);
  if (url === "/status") return handleStatus(req, res);

  res.writeHead(404);
  res.end("Not Found");
});

serverStartTime = Date.now();

server.listen(PORT, () => {
  console.log(`\n🌪️  API Apocalypse Mock Server running on http://localhost:${PORT}`);
  console.log(`\n   Endpoints:`);
  console.log(`     GET /source-a  (JSON → restructured → rate-limited)`);
  console.log(`     GET /source-b  (XML  → restructured → offline)`);
  console.log(`     GET /source-c  (CSV  → column reorder)`);
  console.log(`     GET /status    (current phase info)\n`);
  console.log(`   Chaos schedule:`);
  for (const p of PHASES) {
    console.log(`     t=${p.startOffsetMs / 1000}s\t${p.label}`);
  }
  console.log(`\n   Experiment duration: 180s (3 minutes)\n`);
});
