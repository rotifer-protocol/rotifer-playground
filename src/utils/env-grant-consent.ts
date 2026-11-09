import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AlgebraResultView, ExecutionResultView, NativeBinding } from "./binding.js";
import * as display from "./display.js";
import { isExternallySourced } from "./l0-gate.js";

/**
 * A gene from outside this workspace may use a credential from the user's
 * environment only with the user's say-so, and only at the hosts it declared
 * for that credential (#508). The grant lasts for this one command.
 *
 * Every sandbox call in the CLI goes through `executeGene` / `executeAlgebra`
 * below, which is what makes the limit hold; tests/security/sandbox-call-sites
 * fails if one goes around them.
 */

export const ALLOW_CREDENTIALS_OPTION = [
  "--allow-credentials <list>",
  "let external genes use these credentials, each only at its host: KEY@api.example.com,KEY2@other.example.com",
] as const;

export interface GeneRef {
  name: string;
  dir: string;
}

export interface CredentialPair {
  credential: string;
  domain: string;
}

export interface GeneCredentialRequest {
  gene: string;
  pairs: CredentialPair[];
  /** Declared in a way no grant can cover: not an env name, or not one exact host. */
  notGrantable: CredentialPair[];
}

export type CredentialScope = Record<string, string[]>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** C0, DEL and C1 controls, and the marks that reorder text on screen. */
const UNPRINTABLE: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]];

const pairKey = (p: CredentialPair) => `${p.credential}@${p.domain}`;

/** Makes text from a gene's phenotype safe to print: nothing in it can drive the terminal. */
export function printable(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return UNPRINTABLE.some(([low, high]) => code >= low && code <= high) ? `\\u{${code.toString(16)}}` : ch;
  }).join("");
}

/** The credentials a gene can actually be given: Rust grants them only to a Hybrid gene with a network block. */
export function declaredCredentials(phenotype: unknown): Omit<GeneCredentialRequest, "gene"> {
  const pairs: CredentialPair[] = [];
  const notGrantable: CredentialPair[] = [];
  const p = phenotype as { fidelity?: unknown; network?: unknown; externalDependencies?: unknown } | null;
  if (typeof p?.fidelity !== "string" || p.fidelity.toLowerCase() !== "hybrid" || !p.network) {
    return { pairs, notGrantable };
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  for (const dep of Array.isArray(p.externalDependencies) ? p.externalDependencies : []) {
    const domains = strings(dep?.domains);
    for (const credential of strings(dep?.credentials)) {
      if (domains.length === 0) notGrantable.push({ credential, domain: "" });
      for (const raw of domains) {
        const domain = raw.toLowerCase();
        const target = ENV_NAME.test(credential) && HOST.test(domain) ? pairs : notGrantable;
        if (!target.some((x) => pairKey(x) === `${credential}@${domain}`)) {
          target.push({ credential, domain });
        }
      }
    }
  }
  return { pairs, notGrantable };
}

export class InvalidCredentialFlag extends Error {}

export function parseAllowCredentials(raw: string | undefined): Set<string> {
  const grant = new Set<string>();
  if (raw === undefined) return grant;
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split("@");
    const domain = (parts[1] ?? "").toLowerCase();
    if (parts.length !== 2 || !ENV_NAME.test(parts[0]) || !HOST.test(domain)) {
      throw new InvalidCredentialFlag(
        "--allow-credentials takes NAME@host entries separated by commas, for example KEY@api.example.com",
      );
    }
    grant.add(`${parts[0]}@${domain}`);
  }
  return grant;
}

function readPhenotype(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, "phenotype.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** What each external gene wants. Genes from this workspace are not listed. */
export function externalRequests(genes: GeneRef[]): GeneCredentialRequest[] {
  const requests: GeneCredentialRequest[] = [];
  for (const { name, dir } of genes) {
    if (!isExternallySourced(dir)) continue;
    const declared = declaredCredentials(readPhenotype(dir));
    if (declared.pairs.length + declared.notGrantable.length > 0) {
      requests.push({ gene: name, ...declared });
    }
  }
  return requests;
}

export type ConsentOutcome =
  | { kind: "granted"; grant: Set<string> }
  | { kind: "not_grantable"; requests: GeneCredentialRequest[] }
  | { kind: "not_granted"; missing: (CredentialPair & { gene: string })[]; declined: boolean };

export interface ConsentIo {
  interactive: boolean;
  ask(question: string): Promise<string>;
  say(line: string): void;
}

/** Decides once, for every gene the command will run. The user is asked at most one question. */
export async function decideConsent(
  requests: GeneCredentialRequest[],
  flagGrant: Set<string>,
  io: ConsentIo,
): Promise<ConsentOutcome> {
  const notGrantable = requests.filter((r) => r.notGrantable.length > 0);
  if (notGrantable.length > 0) return { kind: "not_grantable", requests: notGrantable };

  const missing = requests.flatMap((r) =>
    r.pairs.filter((p) => !flagGrant.has(pairKey(p))).map((p) => ({ gene: r.gene, ...p })),
  );
  if (missing.length === 0) return { kind: "granted", grant: flagGrant };
  if (!io.interactive) return { kind: "not_granted", missing, declined: false };

  io.say("These external genes want to use credentials from your environment:");
  for (const m of missing) {
    io.say(`  ${printable(m.gene)}: ${printable(m.credential)} → ${printable(m.domain)}`);
  }
  const answer = (await io.ask("Allow this for this run? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return { kind: "not_granted", missing, declined: true };
  return { kind: "granted", grant: new Set([...flagGrant, ...missing.map(pairKey)]) };
}

function askOnTerminal(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("close", () => resolve(""));
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

async function stop(json: Record<string, unknown> | null, lines: () => void): Promise<never> {
  if (json) {
    await new Promise<void>((resolve) => process.stdout.write(JSON.stringify(json) + "\n", () => resolve()));
  } else {
    lines();
  }
  process.exit(1);
}

let granted = new Set<string>();

/**
 * Call before the first sandbox run of a command, with every gene it may run.
 * Returns when the run may go ahead; otherwise reports why and exits 1.
 */
export async function requireCredentialConsent(
  genes: GeneRef[],
  options: { allowCredentials?: string; json?: boolean },
): Promise<void> {
  const isJson = Boolean(options.json) || display.isJsonMode();

  let flagGrant: Set<string>;
  try {
    flagGrant = parseAllowCredentials(options.allowCredentials);
  } catch (err) {
    const message = (err as Error).message;
    return stop(isJson ? { ok: false, code: "invalid_allow_credentials", error: message } : null, () =>
      display.error(message),
    );
  }

  const outcome = await decideConsent(externalRequests(genes), flagGrant, {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isJson,
    ask: askOnTerminal,
    say: (line) => console.log(line),
  });

  if (outcome.kind === "granted") {
    granted = outcome.grant;
    return;
  }

  if (outcome.kind === "not_grantable") {
    const credentials = outcome.requests.flatMap((r) => r.notGrantable.map((p) => ({ gene: r.gene, ...p })));
    const nextStep =
      "These genes cannot be given credentials. Each credential needs an environment-variable name and exact hosts; " +
      "ask the gene's author to declare them.";
    return stop(isJson ? { ok: false, code: "credentials_not_grantable", credentials, next_step: nextStep } : null, () => {
      display.error("credentials_not_grantable: an external gene declares credentials that cannot be limited to a host");
      for (const c of credentials) {
        console.error(`  ${printable(c.gene)}: ${printable(c.credential)} → ${printable(c.domain) || "(no host declared)"}`);
      }
      display.hint(nextStep);
    });
  }

  const allow = [...new Set(outcome.missing.map(pairKey))].join(",");
  const nextStep =
    `Ask the user whether these genes may send these credentials to these hosts. ` +
    `If they agree, run the same command again with --allow-credentials ${allow}`;
  return stop(
    isJson ? { ok: false, code: "credentials_not_granted", missing: outcome.missing, next_step: nextStep } : null,
    () => {
      display.error(
        outcome.declined
          ? "credentials_not_granted: not run, the credentials were not allowed"
          : "credentials_not_granted: an external gene needs your OK to use credentials from your environment",
      );
      for (const m of outcome.missing) {
        console.error(`  ${printable(m.gene)}: ${printable(m.credential)} → ${printable(m.domain)}`);
      }
      display.hint(`To allow it, run the same command with --allow-credentials ${allow}`);
    },
  );
}

/** undefined for a gene from this workspace; for an external one, only the granted pairs it declared. */
export function credentialScope(geneDir: string, phenotype: unknown, grant: ReadonlySet<string> = granted): CredentialScope | undefined {
  if (!isExternallySourced(geneDir)) return undefined;
  const scope: CredentialScope = {};
  for (const p of declaredCredentials(phenotype).pairs) {
    if (grant.has(pairKey(p))) (scope[p.credential] ??= []).push(p.domain);
  }
  return scope;
}

function parsedOrNull(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function executeGene(
  binding: Pick<NativeBinding, "executeGene">,
  geneDir: string,
  wasmBytes: Buffer,
  inputJson: string,
  phenotypeJson: string,
  constraintsJson?: string,
  memoryContextJson?: string,
): ExecutionResultView {
  const scope = credentialScope(geneDir, parsedOrNull(phenotypeJson));
  return binding.executeGene(
    wasmBytes,
    inputJson,
    phenotypeJson,
    constraintsJson,
    memoryContextJson,
    scope && JSON.stringify(scope),
  );
}

/** `genes` maps each key of `geneEntriesJson` to the gene's directory and phenotype. */
export function executeAlgebra(
  binding: Pick<NativeBinding, "executeAlgebra">,
  genes: Record<string, { dir: string; phenotype: unknown }>,
  algebraJson: string,
  geneEntriesJson: string,
  inputJson: string,
  constraintsJson?: string,
  memoryContextJson?: string,
): AlgebraResultView {
  const scopes: Record<string, CredentialScope> = {};
  for (const [id, gene] of Object.entries(genes)) {
    const scope = credentialScope(gene.dir, gene.phenotype);
    if (scope) scopes[id] = scope;
  }
  return binding.executeAlgebra(
    algebraJson,
    geneEntriesJson,
    inputJson,
    constraintsJson,
    memoryContextJson,
    JSON.stringify(scopes),
  );
}

/** The genes of `names` that will run in the sandbox. */
export function compiledGenes(genesDir: string, names: string[]): GeneRef[] {
  return names
    .map((name) => ({ name, dir: join(genesDir, name) }))
    .filter((g) => existsSync(join(g.dir, "gene.ir.wasm")));
}
