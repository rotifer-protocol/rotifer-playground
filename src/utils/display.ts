import chalk from "chalk";

export function success(message: string): void {
  console.log(chalk.green("✓") + " " + message);
}

export function error(message: string, detail?: string): void {
  console.error(chalk.red("✗") + " " + chalk.red(message));
  if (detail) {
    console.error(chalk.dim("  → " + detail));
  }
}

export function info(message: string): void {
  console.log(chalk.blue("ℹ") + " " + message);
}

export function warn(message: string): void {
  console.log(chalk.yellow("⚠") + " " + message);
}

export function header(title: string): void {
  console.log();
  console.log(chalk.bold.cyan(`  ${title}`));
  console.log(chalk.dim("  " + "─".repeat(title.length + 2)));
}

export function keyValue(key: string, value: string): void {
  console.log(`  ${chalk.dim(key + ":")} ${value}`);
}

export function geneId(id: string): string {
  return chalk.yellow(id.slice(0, 12) + "…");
}

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
    chalk.red.bold(`error[${opts.code}]`) + chalk.bold(`: ${opts.message}`)
  );
  if (opts.file) {
    console.error(
      chalk.blue(" --> ") + opts.file + (opts.line ? `:${opts.line}` : "")
    );
  }
  if (opts.suggestion) {
    console.error();
    console.error(chalk.green("help") + `: ${opts.suggestion}`);
  }
  if (opts.docsUrl) {
    console.error(
      chalk.dim("docs") + `: ${opts.docsUrl}`
    );
  }
  console.error();
}
