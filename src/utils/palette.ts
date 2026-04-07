import chalk from "chalk";

/**
 * Bioluminescence brand palette (ADR-190)
 * Inspired by rotifer chloroplast symbiosis bioluminescence.
 */
export const hex = {
  accent:       "#00C9A7",
  accentBright: "#00FFD1",
  accentDim:    "#009E84",
  brand:        "#6366F1",
  info:         "#6EC6FF",
  success:      "#4ADE80",
  warn:         "#FBBF24",
  error:        "#F87171",
  muted:        "#94A3B8",
} as const;

/**
 * Semantic color functions. Uses getters so that chalk.level changes
 * (e.g. --plain sets level=0) take effect at call time, not import time.
 * chalk v4's .hex() captures level at creation — getters recreate per access.
 */
export const c = {
  get accent()       { return chalk.hex(hex.accent); },
  get accentBright() { return chalk.hex(hex.accentBright); },
  get accentDim()    { return chalk.hex(hex.accentDim); },
  get brand()        { return chalk.hex(hex.brand); },
  get info()         { return chalk.hex(hex.info); },
  get success()      { return chalk.hex(hex.success); },
  get warn()         { return chalk.hex(hex.warn); },
  get error()        { return chalk.hex(hex.error); },
  get muted()        { return chalk.hex(hex.muted); },
  get bold()         { return chalk.bold; },
  get dim()          { return chalk.dim; },
};

export const icon = {
  success: "✓",
  error:   "✗",
  warn:    "⚠",
  info:    "ℹ",
  arrow:   "→",
  bullet:  "•",
  dash:    "─",
  up:      "↑",
  down:    "↓",
} as const;

export function fidelityColor(fidelity: string): string {
  if (fidelity === "Native") return c.success(fidelity);
  if (fidelity === "Hybrid") return c.brand(fidelity);
  return c.muted(fidelity);
}

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return c.muted("—");
  if (score >= 0.7) return c.success(score.toFixed(4));
  if (score >= 0.3) return c.warn(score.toFixed(4));
  return c.muted(score.toFixed(4));
}

export function scoreColor2(score: number | null | undefined): string {
  if (score == null) return c.muted("—");
  if (score >= 0.7) return c.success(score.toFixed(2));
  if (score >= 0.3) return c.warn(score.toFixed(2));
  return c.muted(score.toFixed(2));
}
