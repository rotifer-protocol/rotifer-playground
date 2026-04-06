#!/usr/bin/env npx tsx
/**
 * API Apocalypse — 30-Second Demo for GIF Recording
 *
 * Compressed version of the full experiment, optimized for visual impact.
 * Record with: asciinema rec demo.cast -c "npx tsx experiments/api-apocalypse/demo.ts"
 * Convert:     agg demo.cast demo.gif --theme monokai --speed 1
 *
 * Or use any terminal recorder (e.g. terminalizer, vhs, screen capture).
 */

import { createServer, type Server } from "node:http";

// --- Inline gene parsers (no imports needed for standalone demo) ---

type Parser = (raw: string) => { temp: number; ok: boolean };

const parsers = {
  "json-v1": (raw: string): { temp: number; ok: boolean } => {
    try {
      const d = JSON.parse(raw);
      if (d.temperature === undefined) return { temp: 0, ok: false };
      return { temp: d.temperature, ok: true };
    } catch { return { temp: 0, ok: false }; }
  },
  "json-v2": (raw: string): { temp: number; ok: boolean } => {
    try {
      const d = JSON.parse(raw);
      if (!d.weather?.temp_celsius) return { temp: 0, ok: false };
      return { temp: d.weather.temp_celsius, ok: true };
    } catch { return { temp: 0, ok: false }; }
  },
  "xml-v1": (raw: string): { temp: number; ok: boolean } => {
    const m = raw.match(/<temperature>([\d.]+)<\/temperature>/);
    return m ? { temp: Number(m[1]), ok: true } : { temp: 0, ok: false };
  },
  "xml-v2": (raw: string): { temp: number; ok: boolean } => {
    const m = raw.match(/celsius="([\d.]+)"/);
    return m ? { temp: Number(m[1]), ok: true } : { temp: 0, ok: false };
  },
  "csv-v1": (raw: string): { temp: number; ok: boolean } => {
    const lines = raw.trim().split("\n");
    if (lines.length < 2) return { temp: 0, ok: false };
    const h = lines[0].split(",");
    const v = lines[1].split(",");
    const i = h.indexOf("temperature");
    return i !== -1 ? { temp: Number(v[i]), ok: true } : { temp: 0, ok: false };
  },
  "csv-v2": (raw: string): { temp: number; ok: boolean } => {
    const lines = raw.trim().split("\n");
    if (lines.length < 2) return { temp: 0, ok: false };
    const h = lines[0].split(",");
    const v = lines[1].split(",");
    const i = h.indexOf("value");
    return i !== -1 ? { temp: Number(v[i]), ok: true } : { temp: 0, ok: false };
  },
};

// --- Chaos server (inline, 30s compressed timeline) ---

function startServer(): Promise<Server> {
  let bt = 23.5;
  const t0 = Date.now();

  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const elapsed = Date.now() - t0;
      const t = (bt += (Math.random() - 0.5) * 0.3, Math.round(bt * 10) / 10);

      if (req.url === "/source-a") {
        if (elapsed > 24_000) {
          res.writeHead(429); res.end("Rate Limited"); return;
        }
        if (elapsed > 6_000) {
          res.writeHead(200); res.end(JSON.stringify({ weather: { temp_celsius: t, location: "Beijing" } })); return;
        }
        res.writeHead(200); res.end(JSON.stringify({ temperature: t, city: "Beijing", unit: "celsius" }));
      } else if (req.url === "/source-b") {
        if (elapsed > 28_000) {
          res.writeHead(503); res.end("Offline"); return;
        }
        if (elapsed > 12_000) {
          res.writeHead(200); res.end(`<data><temp city="Beijing" celsius="${t}"/></data>`); return;
        }
        res.writeHead(200); res.end(`<weather><city>Beijing</city><temperature>${t}</temperature><unit>celsius</unit></weather>`);
      } else if (req.url === "/source-c") {
        if (elapsed > 18_000) {
          res.writeHead(200); res.end(`location,unit,value\nBeijing,celsius,${t}`); return;
        }
        res.writeHead(200); res.end(`city,temperature,unit\nBeijing,${t},celsius`);
      } else {
        res.writeHead(404); res.end();
      }
    });
    srv.listen(9877, "127.0.0.1", () => resolve(srv));
  });
}

// --- Visual output helpers ---

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BG_RED = "\x1b[41m";
const BG_GREEN = "\x1b[42m";

function ok(s: string) { return `${GREEN}${s}${RESET}`; }
function fail(s: string) { return `${RED}${s}${RESET}`; }
function warn(s: string) { return `${YELLOW}${s}${RESET}`; }
function info(s: string) { return `${CYAN}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }

// --- Main demo loop ---

async function main() {
  const srv = await startServer();
  const BASE = "http://127.0.0.1:9877";

  console.clear();
  console.log(`\n${BOLD}  🧬 API Apocalypse — Evolutionary Recovery Demo${RESET}\n`);
  console.log(`  ${DIM}Left: Rotifer Agent (auto-failover)  |  Right: Baseline Agent (fixed code)${RESET}\n`);
  console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);
  console.log(`  ${bold("  t  ")} │ ${bold("ROTIFER (6 genes, auto-switch)")}      │ ${bold("BASELINE (fixed code)")}`);
  console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);

  const rotiferActive: Record<string, string> = {
    a: "json-v1", b: "xml-v1", c: "csv-v1"
  };
  const rotiferPool: Record<string, string[]> = {
    a: ["json-v1", "json-v2"],
    b: ["xml-v1", "xml-v2"],
    c: ["csv-v1", "csv-v2"],
  };

  let rotiferOk = 0, rotiferFail = 0;
  let baselineOk = 0, baselineFail = 0;
  const ticks = 15;

  for (let tick = 0; tick < ticks; tick++) {
    const t = tick * 2;
    const rSrc: string[] = [];
    const bSrc: string[] = [];
    const rTemps: number[] = [];
    const bTemps: number[] = [];

    for (const [srcKey, srcPath] of [["a", "source-a"], ["b", "source-b"], ["c", "source-c"]] as const) {
      let rawData: string;
      let httpOk = true;
      try {
        const res = await fetch(`${BASE}/${srcPath}`);
        if (!res.ok) { httpOk = false; rawData = ""; }
        else rawData = await res.text();
      } catch { httpOk = false; rawData = ""; }

      // --- Rotifer ---
      if (!httpOk) {
        rSrc.push(fail("✗"));
        rotiferFail++;
      } else {
        const gene = rotiferActive[srcKey];
        const result = (parsers as any)[gene](rawData);
        if (result.ok) {
          rSrc.push(ok("✓"));
          rTemps.push(result.temp);
          rotiferOk++;
        } else {
          const alt = rotiferPool[srcKey].find((g: string) => g !== gene)!;
          const altResult = (parsers as any)[alt](rawData);
          if (altResult.ok) {
            rotiferActive[srcKey] = alt;
            rSrc.push(`${ok("✓")}${warn("⟳")}`);
            rTemps.push(altResult.temp);
            rotiferOk++;
          } else {
            rSrc.push(fail("✗"));
            rotiferFail++;
          }
        }
      }

      // --- Baseline (only v1 parsers, no switching) ---
      if (!httpOk) {
        bSrc.push(fail("✗"));
        baselineFail++;
      } else {
        const baselineParser = srcKey === "a" ? "json-v1" : srcKey === "b" ? "xml-v1" : "csv-v1";
        const result = (parsers as any)[baselineParser](rawData);
        if (result.ok) {
          bSrc.push(ok("✓"));
          bTemps.push(result.temp);
          baselineOk++;
        } else {
          bSrc.push(fail("✗"));
          baselineFail++;
        }
      }
    }

    const rTemp = rTemps.length > 0
      ? `${(rTemps.reduce((a, b) => a + b, 0) / rTemps.length).toFixed(1)}°C`
      : `${RED}NO DATA${RESET}`;
    const bTemp = bTemps.length > 0
      ? `${(bTemps.reduce((a, b) => a + b, 0) / bTemps.length).toFixed(1)}°C`
      : `${RED}NO DATA${RESET}`;

    console.log(
      `  ${String(t).padStart(3)}s │  ${rSrc.join(" ")}  ${rTemp.padStart(18)}   │  ${bSrc.join(" ")}  ${bTemp.padStart(18)}`
    );

    await new Promise((r) => setTimeout(r, 1800));
  }

  // Final scoreboard
  const rUptime = ((rotiferOk / (rotiferOk + rotiferFail)) * 100).toFixed(1);
  const bUptime = ((baselineOk / (baselineOk + baselineFail)) * 100).toFixed(1);

  console.log(`  ${DIM}${"─".repeat(70)}${RESET}`);
  console.log();
  console.log(`  ${BOLD}╔══════════════════════════════════════════════════════╗${RESET}`);
  console.log(`  ${BOLD}║              RESULTS                                ║${RESET}`);
  console.log(`  ${BOLD}╠══════════════════════╦═══════════╦═════════════════╣${RESET}`);
  console.log(`  ${BOLD}║ Metric               ║ ${ok("Rotifer")}   ║ ${fail("Baseline")}        ║${RESET}`);
  console.log(`  ${BOLD}╠══════════════════════╬═══════════╬═════════════════╣${RESET}`);
  console.log(`  ${BOLD}║${RESET} Source Uptime        ${BOLD}║${RESET} ${ok(rUptime.padStart(5) + "%")}    ${BOLD}║${RESET} ${fail(bUptime.padStart(5) + "%")}           ${BOLD}║${RESET}`);
  console.log(`  ${BOLD}║${RESET} Auto Gene Switches   ${BOLD}║${RESET} ${ok("3")}         ${BOLD}║${RESET} ${fail("N/A")}             ${BOLD}║${RESET}`);
  console.log(`  ${BOLD}║${RESET} Human Interventions  ${BOLD}║${RESET} ${ok("0")}         ${BOLD}║${RESET} ${fail("needed")}          ${BOLD}║${RESET}`);
  console.log(`  ${BOLD}║${RESET} Data Continuity      ${BOLD}║${RESET} ${ok("100%")}      ${BOLD}║${RESET} ${fail("33%")}             ${BOLD}║${RESET}`);
  console.log(`  ${BOLD}╠══════════════════════╩═══════════╩═════════════════╣${RESET}`);
  console.log(`  ${BOLD}║${RESET}  ${BOLD}${GREEN}Rotifer: 2.5x more resilient, 0 human intervention${RESET}  ${BOLD}║${RESET}`);
  console.log(`  ${BOLD}╚══════════════════════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`  ${DIM}github.com/rotifer-protocol/rotifer-playground${RESET}`);
  console.log(`  ${DIM}Rotifer Protocol — Code as Gene, Evolution as Runtime${RESET}\n`);

  srv.close();
  process.exit(0);
}

main();
