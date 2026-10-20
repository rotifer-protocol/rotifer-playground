import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/**
 * Real Registry genes for the genome import e2e tests (read-only; selected
 * 2026-10-20 from `rotifer --json arena list --cloud` and the published gene
 * rows). Arena rows often point at an older version without a WASM artifact,
 * so the pins below are the versions that carry one — only those yield a v2
 * gene ID after install.
 *
 * Run these suites with ROTIFER_E2E_REGISTRY=1 (and a native addon that has
 * geneIdV2). CI leaves the switch unset: they depend on the public network.
 */
export const REGISTRY_E2E = process.env.ROTIFER_E2E_REGISTRY === "1";

export const GENES = {
  /** Native, takes { text }. */
  grammarChecker: { id: "3d3e3a08-21ce-4475-aa79-85839de52aca", name: "grammar-checker", version: "0.2.1" },
  readabilityAnalyzer: { id: "c2cb486b-a8ec-4a44-b996-b390e8c5dd99", name: "readability-analyzer", version: "0.2.1" },
  textSummarizer: { id: "6809efd0-c479-4385-a4e3-dba672c7c837", name: "text-summarizer", version: "0.2.0" },
  /** Native with two published versions that both carry WASM. */
  urlExtractorOld: { id: "4a2da58c-f92a-45f6-b8ee-e5e05d251a9f", name: "url-extractor", version: "0.2.0" },
  urlExtractorNew: { id: "d9dcc1b4-4306-4800-bfe6-aa4d31e668bb", name: "url-extractor", version: "0.2.1" },
  /** Hybrid with WASM. */
  polymarketScanner: { id: "a9114688-316c-4588-938d-681a81a1dd92", name: "polymarket-scanner", version: "0.3.1" },
} as const;

/** An Arena domain whose real rows are all Native/Hybrid and none verified (as of 2026-10-20). */
export const CAPABILITY_DOMAIN = "content.grammar";

export const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

const execFileP = promisify(execFile);

/**
 * Run the CLI without blocking the event loop — the test's registry proxy runs
 * in this process and must keep answering while the child waits on it.
 */
export async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; out: string }> {
  try {
    const r = await execFileP("node", [CLI, ...args], { cwd, env, encoding: "utf-8", timeout: 120_000 });
    return { code: 0, stdout: r.stdout, out: r.stdout + r.stderr };
  } catch (e: any) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** A child environment with only what the CLI needs: no inherited credentials. */
export function cliEnv(home: string, endpoint: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ROTIFER_CLOUD_ENDPOINT: endpoint,
    ROTIFER_NO_UPDATE_CHECK: "1",
    ROTIFER_TELEMETRY: "off",
    FORCE_COLOR: "0",
  };
}

/** The JSON value `agent run` prints after "Final output:" (it has no --json mode). */
export function extractFinalOutput(out: string): unknown {
  const at = out.indexOf("Final output:");
  if (at < 0) throw new Error("no 'Final output:' in agent run output");
  const rest = out.slice(at + "Final output:".length);
  const start = rest.search(/[[{]/);
  if (start < 0) throw new Error("no JSON after 'Final output:'");
  let depth = 0;
  let inString = false;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return JSON.parse(rest.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON after 'Final output:'");
}
