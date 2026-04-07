import chalk from "chalk";
import type { Command, Help } from "commander";
import { c, icon } from "./palette.js";

// ── Output mode ──────────────────────────────────────────────

export type OutputMode = "human" | "json" | "plain";

let _mode: OutputMode = "human";

export function setOutputMode(mode: OutputMode): void {
  _mode = mode;
  if (mode === "plain" || mode === "json") {
    chalk.level = 0 as typeof chalk.Level;
  }
}

export function getOutputMode(): OutputMode {
  return _mode;
}

export function isJsonMode(): boolean {
  return _mode === "json";
}

// ── Semantic messages ────────────────────────────────────────

export function success(message: string): void {
  console.log(c.success(icon.success) + " " + message);
}

export function error(message: string, detail?: string): void {
  console.error(c.error(icon.error) + " " + c.error(message));
  if (detail) {
    console.error(c.muted("  " + icon.arrow + " " + detail));
  }
}

export function info(message: string): void {
  console.log(c.info(icon.info) + " " + message);
}

export function warn(message: string): void {
  console.log(c.warn(icon.warn) + " " + message);
}

export function hint(message: string): void {
  console.log(c.muted(icon.info) + " " + c.muted(message));
}

// ── Header ───────────────────────────────────────────────────

export function header(title: string, opts?: { separator?: boolean }): void {
  console.log();
  console.log(c.accent.bold(`  ${title}`));
  if (opts?.separator !== false) {
    console.log(c.muted("  " + icon.dash.repeat(title.length + 2)));
  }
}

// ── Key-Value ────────────────────────────────────────────────

export function keyValue(key: string, value: string): void {
  console.log(`  ${c.accent(key + ":")} ${value}`);
}

export const kv = keyValue;

// ── Gene ID formatter ────────────────────────────────────────

export function geneId(id: string): string {
  if (id.length <= 12) return c.warn(id);
  return c.warn(id.slice(0, 12) + "…");
}

// ── Rust-style error ─────────────────────────────────────────

export function rustStyleError(opts: {
  code: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
  docsUrl?: string;
}): void {
  console.error();
  console.error(
    c.error.bold(`error[${opts.code}]`) + c.bold(`: ${opts.message}`)
  );
  if (opts.file) {
    console.error(
      c.info(" --> ") + opts.file + (opts.line ? `:${opts.line}` : "")
    );
  }
  if (opts.suggestion) {
    console.error();
    console.error(c.success("help") + `: ${opts.suggestion}`);
  }
  if (opts.docsUrl) {
    console.error(c.muted("docs") + `: ${link(opts.docsUrl, opts.docsUrl)}`);
  }
  console.error();
}

// ── OSC-8 Hyperlink ──────────────────────────────────────────

export function link(text: string, url: string): string {
  if (!process.stderr.isTTY && !process.stdout.isTTY) return `${text} (${url})`;
  if (chalk.level === 0) return `${text} (${url})`;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// ── Spinner ──────────────────────────────────────────────────

export interface Spinner {
  stop(successMessage?: string): void;
  update(message: string): void;
}

export function spinner(message: string): Spinner {
  if (!process.stderr.isTTY || _mode !== "human") {
    process.stderr.write(message + "\n");
    return {
      update() {},
      stop(finalMessage?: string) {
        if (finalMessage) console.log(finalMessage);
      },
    };
  }

  const frames = ["◒", "◐", "◓", "◑"];
  let frame = 0;
  let msg = message;
  const write = (text: string) => process.stderr.write(text);

  write(`  ${c.accent(frames[0])} ${msg}`);

  const interval = setInterval(() => {
    frame = (frame + 1) % frames.length;
    write(`\x1b[2K\r  ${c.accent(frames[frame])} ${msg}`);
  }, 80);

  return {
    update(newMessage: string) {
      msg = newMessage;
    },
    stop(finalMessage?: string) {
      clearInterval(interval);
      write("\x1b[2K\r");
      if (finalMessage) console.log(finalMessage);
    },
  };
}

// ── Brand Banner ─────────────────────────────────────────────

export function banner(version: string): string {
  const argv = process.argv;
  if (_mode !== "human" || argv.includes("--plain") || argv.includes("--json")) {
    return "";
  }

  const v = c.muted(`v${version}`);
  const tagline = c.muted("Code as Gene");
  const sep = c.accentDim("─".repeat(32));

  return [
    "",
    `  ${c.accent.bold("◎")} ${c.accent.bold("Rotifer Protocol")}  ${v}`,
    `  ${sep}`,
    `  ${tagline}`,
    "",
  ].join("\n");
}

// ── Grouped Help Formatter (A/C/D) ──────────────────────────

const COMMAND_GROUPS: Array<{ label: string; names: string[] }> = [
  {
    label: "Development",
    names: ["init", "scan", "wrap", "test", "compile", "run", "list"],
  },
  {
    label: "Cloud",
    names: ["login", "logout", "publish", "search", "install"],
  },
  {
    label: "Discovery",
    names: ["info", "stats", "compare", "reputation", "versions"],
  },
  {
    label: "Arena & Agents",
    names: ["arena", "agent"],
  },
  {
    label: "Tools",
    names: ["vg", "network", "self-update", "config", "whoami"],
  },
];

export function formatGroupedHelp(cmd: Command, helper: Help): string {
  const isPlain = _mode === "plain" || process.argv.includes("--plain");
  const lines: string[] = [];

  lines.push(`Usage: ${helper.commandUsage(cmd)}`);
  lines.push("");

  const desc = helper.commandDescription(cmd);
  if (desc) {
    lines.push(desc);
    lines.push("");
  }

  const opts = helper.visibleOptions(cmd);
  if (opts.length > 0) {
    lines.push(isPlain ? "Options:" : c.accent.bold("Options:"));
    const optWidth = helper.padWidth(cmd, helper);
    for (const opt of opts) {
      const term = helper.optionTerm(opt).padEnd(optWidth + 2);
      const desc_ = helper.optionDescription(opt);
      lines.push(isPlain ? `  ${term} ${desc_}` : `  ${term} ${c.muted(desc_)}`);
    }
    lines.push("");
  }

  const allCmds = helper.visibleCommands(cmd);
  const cmdMap = new Map<string, Command>();
  for (const sub of allCmds) cmdMap.set(sub.name(), sub);

  const placed = new Set<string>();

  for (const group of COMMAND_GROUPS) {
    const members = group.names.filter((n) => cmdMap.has(n));
    if (members.length === 0) continue;

    lines.push(isPlain ? `${group.label}:` : c.accent.bold(`${group.label}:`));

    for (const name of members) {
      const sub = cmdMap.get(name)!;
      const usage = helper.subcommandTerm(sub);
      const desc_ = helper.subcommandDescription(sub);
      const padded = usage.padEnd(34);
      lines.push(isPlain ? `  ${padded} ${desc_}` : `  ${padded} ${c.muted(desc_)}`);
      placed.add(name);
    }
    lines.push("");
  }

  const ungrouped = allCmds.filter((sub) => !placed.has(sub.name()));
  if (ungrouped.length > 0) {
    lines.push(isPlain ? "Other:" : c.accent.bold("Other:"));
    for (const sub of ungrouped) {
      const usage = helper.subcommandTerm(sub);
      const desc_ = helper.subcommandDescription(sub);
      lines.push(`  ${usage.padEnd(34)} ${c.muted(desc_)}`);
    }
    lines.push("");
  }

  if (isPlain) {
    lines.push("Run rotifer <command> --help for detailed usage.");
  } else {
    lines.push(c.muted("Run ") + c.accent("rotifer <command> --help") + c.muted(" for detailed usage."));
  }
  lines.push("");

  return lines.join("\n");
}

// ── Subcommand Help Formatter ─────────────────────────────────

export function formatSubcommandHelp(cmd: Command, helper: Help): string {
  const isPlain = _mode === "plain" || process.argv.includes("--plain");
  const lines: string[] = [];

  lines.push(`Usage: ${helper.commandUsage(cmd)}`);
  lines.push("");

  const desc = helper.commandDescription(cmd);
  if (desc) {
    lines.push(desc);
    lines.push("");
  }

  const args = cmd.registeredArguments;
  if (args.length > 0) {
    lines.push(isPlain ? "Arguments:" : c.accent.bold("Arguments:"));
    const argWidth = Math.max(...args.map((a) => a.name().length)) + 4;
    for (const arg of args) {
      const term = arg.name().padEnd(argWidth);
      const argDesc = arg.description || "";
      lines.push(isPlain ? `  ${term} ${argDesc}` : `  ${term} ${c.muted(argDesc)}`);
    }
    lines.push("");
  }

  const opts = helper.visibleOptions(cmd);
  if (opts.length > 0) {
    lines.push(isPlain ? "Options:" : c.accent.bold("Options:"));
    const optWidth = helper.padWidth(cmd, helper);
    for (const opt of opts) {
      const term = helper.optionTerm(opt).padEnd(optWidth + 2);
      const optDesc = helper.optionDescription(opt);
      lines.push(isPlain ? `  ${term} ${optDesc}` : `  ${term} ${c.muted(optDesc)}`);
    }
    lines.push("");
  }

  const subCmds = helper.visibleCommands(cmd);
  if (subCmds.length > 0) {
    lines.push(isPlain ? "Commands:" : c.accent.bold("Commands:"));
    for (const sub of subCmds) {
      const usage = helper.subcommandTerm(sub);
      const subDesc = helper.subcommandDescription(sub);
      lines.push(isPlain ? `  ${usage.padEnd(30)} ${subDesc}` : `  ${usage.padEnd(30)} ${c.muted(subDesc)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Welcome Banner (ASCII Art) ───────────────────────────────

const ASCII_LOGO_LINES = [
  "   ____       _   _  __",
  "  |  _ \\ ___ | |_(_)/ _| ___ _ __",
  "  | |_) / _ \\| __| | |_ / _ \\ '__|",
  "  |  _ < (_) | |_| |  _|  __/ |",
  "  |_| \\_\\___/ \\__|_|_|  \\___|_|",
];

export function welcomeBanner(opts: {
  version: string;
  message?: string;
  hints?: Array<[string, string]>;
  docsUrl?: string;
}): void {
  if (_mode === "json" || process.argv.includes("--json")) return;
  if (process.env.CI) return;

  const isPlain = _mode === "plain" || process.argv.includes("--plain");
  const last = ASCII_LOGO_LINES.length - 1;

  console.log();
  for (let i = 0; i < ASCII_LOGO_LINES.length; i++) {
    const suffix = i === last ? `   v${opts.version}` : "";
    const line = ASCII_LOGO_LINES[i] + suffix;
    console.log(isPlain ? `  ${line}` : `  ${c.accent(line)}`);
  }
  console.log();

  if (opts.message) {
    console.log(isPlain ? `  ${opts.message}` : `  ${c.bold(opts.message)}`);
    console.log();
  }

  if (opts.hints && opts.hints.length > 0) {
    for (const [cmd, desc] of opts.hints) {
      const padded = cmd.padEnd(28);
      console.log(
        isPlain ? `    ${padded} ${desc}` : `    ${c.accent(padded)} ${c.muted(desc)}`,
      );
    }
    console.log();
  }

  if (opts.docsUrl) {
    console.log(
      isPlain
        ? `  Docs: ${opts.docsUrl}`
        : `  ${c.muted("Docs:")} ${link("rotifer.dev/docs", opts.docsUrl)}`,
    );
    console.log();
  }
}

// ── Box ──────────────────────────────────────────────────────

export function box(lines: string[], opts?: { title?: string }): void {
  const allLines = opts?.title ? [c.bold(opts.title), "", ...lines] : lines;
  const maxLen = Math.max(...allLines.map((l) => stripAnsi(l).length), 20);
  const innerW = maxLen + 2;

  const top = c.muted(`  ┌${"─".repeat(innerW)}┐`);
  const bot = c.muted(`  └${"─".repeat(innerW)}┘`);
  const empty = c.muted("  │") + " ".repeat(innerW) + c.muted("│");

  console.log(top);
  console.log(empty);
  for (const line of allLines) {
    const vis = stripAnsi(line).length;
    const right = innerW - vis - 1;
    console.log(c.muted("  │") + " " + line + " ".repeat(Math.max(right, 0)) + c.muted("│"));
  }
  console.log(empty);
  console.log(bot);
}

// ── Table ────────────────────────────────────────────────────

export interface TableColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  width?: number;
  align?: "left" | "right";
  format?: (value: unknown, row: T) => string;
}

export function table<T extends Record<string, unknown>>(
  data: T[],
  columns: TableColumn<T>[],
): void {
  if (data.length === 0) return;

  const termWidth = process.stdout.columns || 120;
  const indent = 2;

  const widths = columns.map((col) => {
    const headerLen = col.label.length;
    const maxDataLen = data.reduce((max, row) => {
      const raw = col.format
        ? stripAnsi(col.format(row[col.key], row))
        : String(row[col.key] ?? "");
      return Math.max(max, raw.length);
    }, 0);
    const autoWidth = Math.max(headerLen, maxDataLen) + 2;
    return col.width ? Math.max(col.width, autoWidth) : autoWidth;
  });

  const totalWidth = widths.reduce((a, b) => a + b, 0) + indent;
  if (totalWidth > termWidth) {
    const overflow = totalWidth - termWidth;
    let remaining = overflow;
    const sorted = widths
      .map((w, i) => ({ w, i }))
      .sort((a, b) => b.w - a.w);
    for (const entry of sorted) {
      if (remaining <= 0) break;
      const minW = Math.max(stripAnsi(columns[entry.i].label).length + 2, 6);
      const canShrink = entry.w - minW;
      if (canShrink <= 0) continue;
      const shrink = Math.min(canShrink, remaining);
      widths[entry.i] -= shrink;
      remaining -= shrink;
    }

    if (remaining > 0) {
      const fallbackOrder = widths
        .map((w, i) => ({ w, i }))
        .sort((a, b) => b.w - a.w);

      while (remaining > 0) {
        let shrunk = false;
        for (const entry of fallbackOrder) {
          if (widths[entry.i] <= 1) continue;
          widths[entry.i] -= 1;
          remaining -= 1;
          shrunk = true;
          if (remaining <= 0) break;
        }
        if (!shrunk) break;
      }
    }
  }

  const headerLine = columns
    .map((col, i) => pad(col.label, widths[i], col.align))
    .join("");
  console.log("  " + c.accent(headerLine));
  console.log("  " + c.accentDim(icon.dash.repeat(widths.reduce((a, b) => a + b, 0))));

  for (const row of data) {
    const cells = columns.map((col, i) => {
      const formatted = col.format
        ? col.format(row[col.key], row)
        : String(row[col.key] ?? "");
      return pad(formatted, widths[i], col.align);
    });
    console.log("  " + cells.join(""));
  }
}

// ── Bar chart ────────────────────────────────────────────────

export function barChart(
  items: { label: string; value: number }[],
  opts: { barWidth?: number } = {},
): void {
  const barWidth = opts.barWidth ?? 30;
  const max = Math.max(...items.map((i) => i.value), 1);
  const maxLabelLen = Math.max(...items.map((i) => i.label.length));

  for (const item of items) {
    const ratio = item.value / max;
    const filled = Math.round(ratio * barWidth);
    const bar = c.accent("█".repeat(filled)) + c.muted("░".repeat(barWidth - filled));
    const label = item.label.padEnd(maxLabelLen);
    console.log(`  ${label}  ${bar}  ${c.bold(String(item.value))}`);
  }
}

// ── Data-first rendering ─────────────────────────────────────

export function renderResult<T>(data: T, humanRenderer: (data: T) => void): void {
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  humanRenderer(data);
}

// ── Internal utilities ───────────────────────────────────────

function truncateAnsi(str: string, maxVisible: number): string {
  let visible = 0;
  let i = 0;
  let result = "";
  let hasAnsi = false;
  const len = str.length;

  while (i < len && visible < maxVisible) {
    if (str[i] === "\x1b") {
      if (str[i + 1] === "[") {
        const end = str.indexOf("m", i);
        if (end !== -1) {
          result += str.slice(i, end + 1);
          i = end + 1;
          hasAnsi = true;
          continue;
        }
      } else if (str[i + 1] === "]") {
        const end = str.indexOf("\x07", i);
        if (end !== -1) {
          result += str.slice(i, end + 1);
          i = end + 1;
          hasAnsi = true;
          continue;
        }
      }
    }
    result += str[i];
    visible++;
    i++;
  }

  return hasAnsi ? result + "\x1b[0m" : result;
}

function pad(str: string, width: number, align: "left" | "right" = "left"): string {
  const visible = stripAnsi(str).length;
  if (visible >= width) {
    if (width <= 2) return stripAnsi(str).slice(0, width);
    const truncated = truncateAnsi(str, width - 2);
    const truncVisible = stripAnsi(truncated).length;
    return truncated + "…" + " ".repeat(Math.max(width - truncVisible - 1, 0));
  }
  const diff = width - visible;
  if (align === "right") {
    const trailing = Math.min(2, diff);
    return " ".repeat(diff - trailing) + str + " ".repeat(trailing);
  }
  return str + " ".repeat(diff);
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");
}
