#!/usr/bin/env npx tsx
/**
 * Generate the API Apocalypse demo SVG animation.
 *
 * Custom SVG — no external dependencies.
 * Colors aligned with rotifer-dev design system (Tokyo Night palette).
 * Uses SVG <line> for table grid + absolute <tspan x=""> for column alignment.
 *
 * Usage: npx tsx experiments/api-apocalypse/generate-svg.ts
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Design tokens (rotifer.dev design system) ---

const C = {
  bg: "#1a1b26",
  chrome: "#111113",
  border: "#27272a",
  gridLine: "#2a2a3a",
  text: "#c0caf5",
  dim: "#565f89",
  bright: "#e2e8f0",
  green: "#22c55e",
  red: "#ef4444",
  yellow: "#eab308",
};

const FONT =
  "'JetBrains Mono','Fira Code','Cascadia Code','SF Mono',Menlo,Consolas,monospace";
const FONT_SIZE = 13;
const LINE_H = 20;
const CHROME_H = 36;
const PAD = { x: 24, y: 16 };
const SVG_W = 720;

// --- Column positions (absolute x) ---

const X = {
  time: 48,
  v1: 66,
  rotSrc: 82,
  rotTemp: 170,
  v2: 282,
  baseSrc: 298,
  baseTemp: 386,
  v3: 498,
  event: 514,
};

const X_HDR_ROT = (X.v1 + X.v2) / 2;
const X_HDR_BASE = (X.v2 + X.v3) / 2;

// --- Row indices ---

const R = {
  title: 0,
  hook: 1,
  legend: 2,
  // 3 = blank
  header: 4,
  // hr after header
  d0: 5,
  evA: 6,
  d8: 7,
  evB: 8,
  d14: 9,
  evC: 10,
  d20: 11,
  evRL: 12,
  d24: 13,
  evOff: 14,
  d28: 15,
  // hr after data
  // 16 = blank
  resHdr: 17,
  resUp: 18,
  resSw: 19,
  resHu: 20,
  // 21 = blank
  conclusion: 22,
  // 23 = blank
  footer: 24,
};

function textY(row: number): number {
  return CHROME_H + PAD.y + row * LINE_H + FONT_SIZE;
}

function rowTop(row: number): number {
  return CHROME_H + PAD.y + row * LINE_H;
}

// --- Table grid boundaries ---

const TABLE_Y1 = rowTop(R.header);
const TABLE_HR1 = rowTop(R.d0);
const TABLE_Y2 = rowTop(R.d28 + 1);
const TABLE_X1 = PAD.x;
const TABLE_X2 = SVG_W - PAD.x;

// --- SVG helpers ---

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface Sp {
  t: string;
  c: string;
  x?: number;
  anchor?: string;
}

const sp = (t: string, c: string, x?: number): Sp => ({ t, c, x });

// --- Animation timing ---

const T = {
  title: 0,
  hook: 0.3,
  legend: 0.6,
  header: 1.5,
  d0: 2.5,
  evA: 3.5,
  d8: 4.5,
  evB: 6.0,
  d14: 7.0,
  evC: 8.5,
  d20: 9.5,
  evRL: 11.0,
  d24: 12.0,
  evOff: 13.0,
  d28: 14.0,
  results: 15.5,
  resUp: 15.8,
  resSw: 16.1,
  resHu: 16.4,
  conclusion: 17.0,
  footer: 18.0,
};

// --- Build SVG ---

function generate(): string {
  const maxRow = R.footer;
  const H = CHROME_H + PAD.y + (maxRow + 1) * LINE_H + PAD.y;

  const o: string[] = [];
  let frameIdx = 0;
  const delays: { idx: number; delay: number }[] = [];

  const ANIM_DUR = "0.35s";
  const smilAnimate = (delay: number) =>
    `<animate attributeName="opacity" from="0" to="1" begin="${delay.toFixed(1)}s" dur="${ANIM_DUR}" fill="freeze"/>`;

  function addFrame(
    row: number,
    delay: number,
    spans: Sp[],
    extraAttr = ""
  ): void {
    frameIdx++;
    delays.push({ idx: frameIdx, delay });
    const y = textY(row);
    let el = `<text y="${y}" opacity="0" font-family="${FONT}" font-size="${FONT_SIZE}"${extraAttr}>`;
    el += smilAnimate(delay);
    for (const s of spans) {
      const xAttr = s.x != null ? ` x="${s.x}"` : "";
      const anchorAttr = s.anchor ? ` text-anchor="${s.anchor}"` : "";
      el += `<tspan${xAttr}${anchorAttr} fill="${s.c}">${esc(s.t)}</tspan>`;
    }
    el += "</text>";
    o.push(el);
  }

  function addGroup(delay: number, content: string): void {
    frameIdx++;
    delays.push({ idx: frameIdx, delay });
    o.push(`<g opacity="0">${smilAnimate(delay)}${content}</g>`);
  }

  // ─── SVG open ──────────────────────────────────────────────────────

  o.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${H}" width="${SVG_W}" height="${H}">`
  );

  // ─── Background + chrome ───────────────────────────────────────────

  o.push(`<rect width="${SVG_W}" height="${H}" rx="8" fill="${C.bg}"/>`);
  o.push(
    `<rect width="${SVG_W}" height="${CHROME_H}" rx="8" fill="${C.chrome}"/>`
  );
  o.push(
    `<rect y="${CHROME_H - 8}" width="${SVG_W}" height="8" fill="${C.chrome}"/>`
  );
  o.push(
    `<line x1="0" y1="${CHROME_H}" x2="${SVG_W}" y2="${CHROME_H}" stroke="${C.border}"/>`
  );

  const dy = CHROME_H / 2;
  o.push(`<circle cx="20" cy="${dy}" r="6" fill="#ff5f57"/>`);
  o.push(`<circle cx="40" cy="${dy}" r="6" fill="#febc2e"/>`);
  o.push(`<circle cx="60" cy="${dy}" r="6" fill="#28c840"/>`);
  o.push(
    `<text x="${SVG_W / 2}" y="${dy + 4}" text-anchor="middle" fill="${C.dim}" font-family="${FONT}" font-size="12">api-apocalypse ─ demo</text>`
  );

  // ─── Title block ───────────────────────────────────────────────────

  addFrame(R.title, T.title, [
    sp("API Apocalypse", C.bright, PAD.x),
    sp(" — Evolutionary Recovery Demo", C.dim),
  ]);

  addFrame(R.hook, T.hook, [
    sp("3 weather APIs · 5 disruptions · 30 seconds", C.dim, PAD.x),
  ]);

  addFrame(R.legend, T.legend, [
    sp("✓", C.green, PAD.x),
    sp(" ok   ", C.dim),
    sp("✗", C.red),
    sp(" fail   ", C.dim),
    sp("⟳", C.yellow),
    sp(" gene switched", C.dim),
  ]);

  // ─── Table grid (SVG lines) ────────────────────────────────────────

  const gridSvg = [
    `<line x1="${X.v1}" y1="${TABLE_Y1}" x2="${X.v1}" y2="${TABLE_Y2}" stroke="${C.gridLine}"/>`,
    `<line x1="${X.v2}" y1="${TABLE_Y1}" x2="${X.v2}" y2="${TABLE_Y2}" stroke="${C.gridLine}"/>`,
    `<line x1="${X.v3}" y1="${TABLE_Y1}" x2="${X.v3}" y2="${TABLE_Y2}" stroke="${C.gridLine}"/>`,
    `<line x1="${TABLE_X1}" y1="${TABLE_HR1}" x2="${TABLE_X2}" y2="${TABLE_HR1}" stroke="${C.gridLine}"/>`,
    `<line x1="${TABLE_X1}" y1="${TABLE_Y2}" x2="${TABLE_X2}" y2="${TABLE_Y2}" stroke="${C.gridLine}"/>`,
  ].join("");

  addGroup(T.header, gridSvg);

  // ─── Table header labels ───────────────────────────────────────────

  addFrame(R.header, T.header, [
    { t: "t", c: C.bright, x: (PAD.x + X.v1) / 2, anchor: "middle" },
    { t: "ROTIFER", c: C.green, x: X_HDR_ROT, anchor: "middle" },
    { t: "BASELINE", c: C.red, x: X_HDR_BASE, anchor: "middle" },
  ]);

  // ─── Data rows ─────────────────────────────────────────────────────

  // Helper: stable source indicators (all green ✓)
  const srcOk = (x: number): Sp[] => [sp("✓ ✓ ✓", C.green, x)];

  // Helper: failed sources
  const srcFail = (a: boolean, b: boolean, c: boolean, x: number): Sp[] => {
    const parts: Sp[] = [
      sp(a ? "✓" : "✗", a ? C.green : C.red, x),
      sp(" ", C.text),
      sp(b ? "✓" : "✗", b ? C.green : C.red),
      sp(" ", C.text),
      sp(c ? "✓" : "✗", c ? C.green : C.red),
    ];
    return parts;
  };

  // Row: 0s — stable (dim)
  addFrame(R.d0, T.d0, [
    sp("0s", C.dim, X.time),
    ...srcOk(X.rotSrc),
    sp("23.5°C", C.dim, X.rotTemp),
    ...srcOk(X.baseSrc),
    sp("23.5°C", C.dim, X.baseTemp),
    sp("normal", C.dim, X.event),
  ]);

  // Event: Source A
  addFrame(R.evA, T.evA, [
    sp("⚡ Source A — JSON format restructured", C.yellow, X.rotSrc),
  ]);

  // Row: 8s — A switched (Rotifer), A failed (Baseline)
  addFrame(R.d8, T.d8, [
    sp("8s", C.text, X.time),
    sp("✓", C.green, X.rotSrc),
    sp("⟳", C.yellow),
    sp(" ✓ ✓", C.green),
    sp("23.2°C", C.text, X.rotTemp),
    ...srcFail(false, true, true, X.baseSrc),
    sp("23.1°C", C.text, X.baseTemp),
    sp("switched!", C.yellow, X.event),
  ]);

  // Event: Source B
  addFrame(R.evB, T.evB, [
    sp("⚡ Source B — XML format restructured", C.yellow, X.rotSrc),
  ]);

  // Row: 14s — B switched (Rotifer), A+B failed (Baseline)
  addFrame(R.d14, T.d14, [
    sp("14s", C.text, X.time),
    sp("✓ ✓", C.green, X.rotSrc),
    sp("⟳", C.yellow),
    sp(" ✓", C.green),
    sp("23.0°C", C.text, X.rotTemp),
    ...srcFail(false, false, true, X.baseSrc),
    sp("22.9°C", C.text, X.baseTemp),
    sp("switched!", C.yellow, X.event),
  ]);

  // Event: Source C
  addFrame(R.evC, T.evC, [
    sp("⚡ Source C — CSV columns reordered", C.yellow, X.rotSrc),
  ]);

  // Row: 20s — C switched (Rotifer), all failed (Baseline → NO DATA)
  addFrame(R.d20, T.d20, [
    sp("20s", C.text, X.time),
    sp("✓ ✓ ✓", C.green, X.rotSrc),
    sp("⟳", C.yellow),
    sp("22.8°C", C.text, X.rotTemp),
    ...srcFail(false, false, false, X.baseSrc),
    sp("NO DATA", C.red, X.baseTemp),
    sp("switched!", C.yellow, X.event),
  ]);

  // Event: Rate limit
  addFrame(R.evRL, T.evRL, [
    sp("⚡ Source A — rate limited (429)", C.yellow, X.rotSrc),
  ]);

  // Row: 24s — A rate-limited, B+C ok (Rotifer); all dead (Baseline)
  addFrame(R.d24, T.d24, [
    sp("24s", C.text, X.time),
    ...srcFail(false, true, true, X.rotSrc),
    sp("23.0°C", C.text, X.rotTemp),
    ...srcFail(false, false, false, X.baseSrc),
    sp("NO DATA", C.red, X.baseTemp),
  ]);

  // Event: Offline
  addFrame(R.evOff, T.evOff, [
    sp("⚡ Source B — offline (503)", C.yellow, X.rotSrc),
  ]);

  // Row: 28s — A+B down, C ok (Rotifer); all dead (Baseline)
  addFrame(R.d28, T.d28, [
    sp("28s", C.text, X.time),
    ...srcFail(false, false, true, X.rotSrc),
    sp("22.9°C", C.text, X.rotTemp),
    ...srcFail(false, false, false, X.baseSrc),
    sp("NO DATA", C.red, X.baseTemp),
  ]);

  // ─── Results ───────────────────────────────────────────────────────

  addFrame(R.resHdr, T.results, [
    { t: "ROTIFER", c: C.green, x: X_HDR_ROT, anchor: "middle" },
    { t: "BASELINE", c: C.red, x: X_HDR_BASE, anchor: "middle" },
  ]);

  addFrame(R.resUp, T.resUp, [
    sp("Uptime", C.dim, X.rotSrc),
    { t: "83.3%", c: C.green, x: X_HDR_ROT, anchor: "middle" },
    { t: "33.3%", c: C.red, x: X_HDR_BASE, anchor: "middle" },
  ]);

  addFrame(R.resSw, T.resSw, [
    sp("Switches", C.dim, X.rotSrc),
    { t: "3", c: C.green, x: X_HDR_ROT, anchor: "middle" },
    { t: "N/A", c: C.red, x: X_HDR_BASE, anchor: "middle" },
  ]);

  addFrame(R.resHu, T.resHu, [
    sp("Human", C.dim, X.rotSrc),
    { t: "0", c: C.green, x: X_HDR_ROT, anchor: "middle" },
    { t: "needed", c: C.red, x: X_HDR_BASE, anchor: "middle" },
  ]);

  // ─── Conclusion + footer ───────────────────────────────────────────

  addFrame(R.conclusion, T.conclusion, [
    sp("▸ ", C.green, PAD.x),
    sp("Rotifer: 2.5x resilience, 0 human intervention", C.green),
  ]);

  addFrame(R.footer, T.footer, [
    sp(
      "github.com/rotifer-protocol/rotifer-playground",
      C.dim,
      PAD.x
    ),
  ]);

  o.push("</svg>");
  return o.join("\n");
}

// --- Output ---

const svg = generate();
const outPath = resolve(__dirname, "demo.svg");
writeFileSync(outPath, svg);

const H = CHROME_H + PAD.y + (R.footer + 1) * LINE_H + PAD.y;

console.log(`✅ SVG generated: ${outPath}`);
console.log(`   Size: ${(svg.length / 1024).toFixed(1)}K`);
console.log(`   Dimensions: ${SVG_W}×${H}`);
console.log(`   Animation: ~${Math.max(T.footer, T.conclusion).toFixed(0)}s + hold`);
