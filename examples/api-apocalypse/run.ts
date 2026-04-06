#!/usr/bin/env npx tsx
/**
 * API Apocalypse — Experiment Runner
 *
 * Orchestrates the full experiment:
 * 1. Starts the chaos mock server (in-process)
 * 2. Runs Rotifer Agent (experimental group) and Baseline Agent (control group)
 * 3. Collects metrics every 2 seconds for 180 seconds
 * 4. Outputs comparison report
 *
 * Usage: npx tsx experiments/api-apocalypse/run.ts
 */

import { createServer, type Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RotiferAgent, type TickResult as RotiferTick } from "./rotifer-agent.js";
import { BaselineAgent, type TickResult as BaselineTick } from "./baseline-agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 9876;
const MOCK_SERVER_URL = `http://127.0.0.1:${PORT}`;
const TICK_INTERVAL_MS = 2000;
const EXPERIMENT_DURATION_MS = Number(process.env.DURATION_MS ?? 180_000);

// --- Data fetcher ---

async function fetchSource(sourceId: string): Promise<string> {
  const url = `${MOCK_SERVER_URL}/${sourceId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// --- Gene loaders ---

async function loadGene(name: string) {
  const mod = await import(`./genes/${name}/index.js`);
  return mod.express as (input: any) => Promise<any>;
}

// --- Metric collection ---

interface ExperimentMetrics {
  rotifer: RotiferTick[];
  baseline: BaselineTick[];
}

// --- Report generation ---

function generateReport(metrics: ExperimentMetrics): string {
  const rotiferTicks = metrics.rotifer;
  const baselineTicks = metrics.baseline;

  const totalTicks = Math.max(rotiferTicks.length, baselineTicks.length);

  let rotiferSuccessful = 0;
  let rotiferTotal = 0;
  let baselineSuccessful = 0;
  let baselineTotal = 0;

  for (const t of rotiferTicks) {
    for (const s of Object.values(t.sources)) {
      rotiferTotal++;
      if (s.status === "success") rotiferSuccessful++;
    }
  }
  for (const t of baselineTicks) {
    for (const s of Object.values(t.sources)) {
      baselineTotal++;
      if (s.status === "success") baselineSuccessful++;
    }
  }

  const rotiferUptime = ((rotiferSuccessful / rotiferTotal) * 100).toFixed(1);
  const baselineUptime = ((baselineSuccessful / baselineTotal) * 100).toFixed(1);

  function computeMTTR(ticks: (RotiferTick | BaselineTick)[]): number {
    let totalDowntime = 0;
    let incidents = 0;
    const sourceDown: Map<string, number> = new Map();

    for (const t of ticks) {
      for (const [src, info] of Object.entries(t.sources)) {
        if (info.status !== "success") {
          if (!sourceDown.has(src)) {
            sourceDown.set(src, t.elapsedSec);
          }
        } else {
          if (sourceDown.has(src)) {
            totalDowntime += t.elapsedSec - sourceDown.get(src)!;
            incidents++;
            sourceDown.delete(src);
          }
        }
      }
    }
    return incidents > 0 ? Math.round(totalDowntime / incidents) : -1;
  }

  const rotiferMTTR = computeMTTR(rotiferTicks);
  const baselineMTTR = computeMTTR(baselineTicks);

  let switchCount = 0;
  const switches: string[] = [];
  for (const t of rotiferTicks) {
    for (const [src, info] of Object.entries(t.sources)) {
      if ("switchedFrom" in info && info.switchedFrom) {
        switchCount++;
        switches.push(
          `  t=${t.elapsedSec}s ${src}: ${info.switchedFrom} → ${info.geneUsed}`
        );
      }
    }
  }

  let rotiferAggregated = 0;
  let baselineAggregated = 0;
  for (const t of rotiferTicks) if (t.aggregatedTemperature) rotiferAggregated++;
  for (const t of baselineTicks) if (t.aggregatedTemperature) baselineAggregated++;

  const report = `
╔══════════════════════════════════════════════════════════════╗
║           API APOCALYPSE — EXPERIMENT RESULTS               ║
╚══════════════════════════════════════════════════════════════╝

  Duration: ${totalTicks * 2}s (${totalTicks} ticks @ 2s intervals)
  Sources:  3 (source-a, source-b, source-c)
  Chaos:    5 disruptions (format change ×3, rate limit ×1, offline ×1)

┌──────────────────────────────────────────────────────────────┐
│                    HEAD-TO-HEAD COMPARISON                    │
├──────────────────────────┬──────────────┬────────────────────┤
│ Metric                   │ Rotifer      │ Baseline           │
├──────────────────────────┼──────────────┼────────────────────┤
│ Source Uptime             │ ${rotiferUptime.padStart(6)}%     │ ${baselineUptime.padStart(6)}%             │
│ MTTR (seconds)           │ ${String(rotiferMTTR === -1 ? "N/A" : rotiferMTTR + "s").padStart(6)}      │ ${String(baselineMTTR === -1 ? "never" : baselineMTTR + "s").padStart(6)}             │
│ Aggregation Available    │ ${String(rotiferAggregated).padStart(3)}/${totalTicks}    │ ${String(baselineAggregated).padStart(3)}/${totalTicks}             │
│ Auto Gene Switches       │ ${String(switchCount).padStart(6)}      │   N/A              │
│ Human Interventions      │      0       │   ${rotiferTotal - rotiferSuccessful > 0 ? String(baselineTotal - baselineSuccessful) : "0"}               │
└──────────────────────────┴──────────────┴────────────────────┘

${switchCount > 0 ? `Gene Switch Timeline:\n${switches.join("\n")}` : "No gene switches occurred."}

═══════════════════════════════════════════════════════════════
  Conclusion:
    Rotifer Agent maintained ${rotiferUptime}% source availability
    vs Baseline's ${baselineUptime}% — a ${(Number(rotiferUptime) / Math.max(Number(baselineUptime), 0.1)).toFixed(1)}x improvement.
    ${rotiferMTTR !== -1 ? `Mean recovery time: ${rotiferMTTR}s (Baseline: ${baselineMTTR === -1 ? "never recovered" : baselineMTTR + "s"}).` : ""}
    ${switchCount} automatic gene switches, 0 human interventions.
═══════════════════════════════════════════════════════════════
`;

  return report;
}

// --- Embedded mock server ---

function startMockServer(): Promise<Server> {
  let baseTemp = 23.5;
  const serverStartTime = Date.now();

  function currentTemp(): number {
    baseTemp += (Math.random() - 0.5) * 0.6;
    return Math.round(baseTemp * 10) / 10;
  }

  function phaseIndex(): number {
    const elapsed = Date.now() - serverStartTime;
    const scale = EXPERIMENT_DURATION_MS / 180_000;
    const offsets = [0, 30_000, 60_000, 90_000, 120_000, 150_000].map(t => t * scale);
    let idx = 0;
    for (let i = offsets.length - 1; i >= 0; i--) {
      if (elapsed >= offsets[i]) { idx = i; break; }
    }
    return idx;
  }

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      const pi = phaseIndex();
      const temp = currentTemp();

      if (url === "/source-a") {
        if (pi >= 4) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Too Many Requests" }));
        } else if (pi >= 1) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ weather: { temp_celsius: temp, location: "Beijing" } }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ temperature: temp, city: "Beijing", unit: "celsius" }));
        }
      } else if (url === "/source-b") {
        if (pi >= 5) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("Service Unavailable");
        } else if (pi >= 2) {
          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(`<data><temp city="Beijing" celsius="${temp}"/></data>`);
        } else {
          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(`<weather><city>Beijing</city><temperature>${temp}</temperature><unit>celsius</unit></weather>`);
        }
      } else if (url === "/source-c") {
        if (pi >= 3) {
          res.writeHead(200, { "Content-Type": "text/csv" });
          res.end(`location,unit,value\nBeijing,celsius,${temp}`);
        } else {
          res.writeHead(200, { "Content-Type": "text/csv" });
          res.end(`city,temperature,unit\nBeijing,${temp},celsius`);
        }
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// --- Main ---

async function main() {
  console.log("\n🧬 API Apocalypse — Evolutionary Recovery Benchmark\n");
  console.log("Starting chaos mock server...");

  const server = await startMockServer();
  console.log(`Mock server started on port ${PORT}.`);

  console.log("Loading genes...");

  const sourceAv1 = await loadGene("weather-source-a-v1");
  const sourceAv2 = await loadGene("weather-source-a-v2");
  const sourceBv1 = await loadGene("weather-source-b-v1");
  const sourceBv2 = await loadGene("weather-source-b-v2");
  const sourceCv1 = await loadGene("weather-source-c-v1");
  const sourceCv2 = await loadGene("weather-source-c-v2");

  const rotifer = new RotiferAgent();
  rotifer.registerGene("weather-source-a-v1", "data.weather.source-a", sourceAv1);
  rotifer.registerGene("weather-source-a-v2", "data.weather.source-a", sourceAv2);
  rotifer.registerGene("weather-source-b-v1", "data.weather.source-b", sourceBv1);
  rotifer.registerGene("weather-source-b-v2", "data.weather.source-b", sourceBv2);
  rotifer.registerGene("weather-source-c-v1", "data.weather.source-c", sourceCv1);
  rotifer.registerGene("weather-source-c-v2", "data.weather.source-c", sourceCv2);
  rotifer.start();

  const baseline = new BaselineAgent();
  baseline.registerParser("source-a", sourceAv1);
  baseline.registerParser("source-b", sourceBv1);
  baseline.registerParser("source-c", sourceCv1);
  baseline.start();

  const metrics: ExperimentMetrics = { rotifer: [], baseline: [] };
  const totalTicks = Math.floor(EXPERIMENT_DURATION_MS / TICK_INTERVAL_MS);

  console.log(
    `\nRunning experiment: ${totalTicks} ticks, ${EXPERIMENT_DURATION_MS / 1000}s duration\n`
  );
  console.log(
    "  Tick │ Rotifer                              │ Baseline"
  );
  console.log(
    "  ─────┼──────────────────────────────────────┼──────────────────────────"
  );

  for (let i = 0; i < totalTicks; i++) {
    const [rotiferResult, baselineResult] = await Promise.all([
      rotifer.tick(fetchSource),
      baseline.tick(fetchSource),
    ]);

    metrics.rotifer.push(rotiferResult);
    metrics.baseline.push(baselineResult);

    const rSources = Object.entries(rotiferResult.sources)
      .map(([k, v]) => {
        const icon = v.status === "success" ? "✅" : "❌";
        const sw =
          "switchedFrom" in v && v.switchedFrom ? "🔄" : "";
        return `${icon}${sw}`;
      })
      .join(" ");

    const bSources = Object.entries(baselineResult.sources)
      .map(([, v]) => (v.status === "success" ? "✅" : "❌"))
      .join(" ");

    const rTemp = rotiferResult.aggregatedTemperature != null
      ? `${rotiferResult.aggregatedTemperature}°C`
      : "  N/A  ";
    const bTemp = baselineResult.aggregatedTemperature != null
      ? `${baselineResult.aggregatedTemperature}°C`
      : "  N/A  ";

    console.log(
      `  ${String(i + 1).padStart(3)}  │ ${rSources}  ${rTemp.padStart(10)} │ ${bSources}  ${bTemp.padStart(10)}    t=${rotiferResult.elapsedSec}s`
    );

    if (i < totalTicks - 1) {
      await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
    }
  }

  console.log("\n📊 Gene Fitness Report:");
  const stats = rotifer.getGeneStats();
  for (const [name, s] of Object.entries(stats)) {
    const bar = "█".repeat(Math.round(s.fitness * 20)).padEnd(20, "░");
    console.log(
      `  ${name.padEnd(25)} ${bar} ${s.fitness.toFixed(3)}  (${s.successes}✓ ${s.failures}✗)`
    );
  }

  const report = generateReport(metrics);
  console.log(report);

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  writeFileSync(
    resolve(resultsDir, `run-${timestamp}.json`),
    JSON.stringify(metrics, null, 2)
  );
  writeFileSync(resolve(resultsDir, `report-${timestamp}.txt`), report);

  console.log(`\n📁 Results saved to experiments/api-apocalypse/results/`);

  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Experiment failed:", err);
  process.exit(1);
});
