import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { geneIdV2 } from "../utils/binding.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { loadCredentials } from "../cloud/auth.js";
import { SENSITIVE_PATTERNS } from "../publish/pre-publish-check.js";
import type { AgentRecord } from "./agent-create.js";

// ── Genome Blueprint format (.rgenome) ───────────────────────
//
// A Blueprint describes an agent's genome so someone else can rebuild it: the
// spec's GenomeSnapshot (§25.1) plus how to find each gene again. It carries
// references and public fields only — never gene code or WASM (§10.4.1).

/** Blueprint format number; an importer refuses a larger one. */
export const BLUEPRINT_FORMAT = 1;

/** Protocol version whose Blueprint layout this command writes. */
export const BLUEPRINT_PROTOCOL_VERSION = { major: 0, minor: 9, patch: 2 } as const;

/** Default `minFitness` for a CapabilityQuery: the recommended τ of §5.1. */
export const DEFAULT_MIN_FITNESS = 0.3;

/** §5.1: V_min MUST lie in [0.5, 1.0). */
export const MIN_VG_FLOOR = 0.5;

/** Key under `bindingExtensions` for semantics only this binding defines. */
export const BINDING_NAME = "rotifer-playground";

export const GENE_ID_V2 = /^v2:[0-9a-f]{64}$/;

export interface GeneReference {
  geneId: string;
  role: string;
  optional: boolean;
}

export type CompareOp = "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE" | "CONTAINS" | "MATCHES";

export interface Predicate {
  field: string;
  operator: CompareOp;
  value: unknown;
}

/** §15.2 AlgebraExpr, externally tagged. v0.9.2 never writes RemoteGene. */
export type AlgebraExpr =
  | { Gene: { geneRef: GeneReference } }
  | { Seq: { steps: AlgebraExpr[] } }
  | { Par: { left: AlgebraExpr; right: AlgebraExpr } }
  | { Cond: { predicate: Predicate; ifTrue: AlgebraExpr; ifFalse: AlgebraExpr } }
  | { TryCatch: { body: AlgebraExpr; handler: AlgebraExpr } };

export interface GenomeSnapshot {
  genes: GeneReference[];
  composition?: AlgebraExpr;
  snapshotAt: string;
}

export interface CapabilityQuery {
  domain: string;
  inputSchemaCompat: unknown;
  outputSchemaCompat: unknown;
  minFitness: number;
  excludeGeneIds?: string[];
}

export interface ResolutionHint {
  owner: string;
  name: string;
  version: string;
  cloudId?: string;
  fidelity: string;
}

export interface GenomeBlueprint {
  blueprintFormat: number;
  protocolVersion: {
    major: number;
    minor: number;
    patch: number;
    supportedFeatures: string[];
  };
  snapshot: GenomeSnapshot;
  metadata: {
    name: string;
    description?: string;
    author?: string;
    createdAt: string;
  };
  capabilities?: Record<string, CapabilityQuery>;
  resolutionHints?: Record<string, ResolutionHint>;
  bindingExtensions?: Record<string, Record<string, unknown>>;
}

export interface RoleSummary {
  role: string;
  geneId: string;
  fidelity: string;
  hasHints: boolean;
}

export class GenomeExportError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly findings?: CredentialFinding[],
  ) {
    super(message);
    this.name = "GenomeExportError";
  }
}

// ── Agent lookup ─────────────────────────────────────────────

/** Find a local agent by id, or by name when the name is unique. */
export function findAgent(root: string, ref: string): AgentRecord {
  const agentsDir = join(root, ".rotifer", "agents");
  const records: AgentRecord[] = existsSync(agentsDir)
    ? readdirSync(agentsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(agentsDir, f), "utf-8")) as AgentRecord)
    : [];

  const byId = records.find((a) => a.id === ref);
  if (byId) return byId;

  const byName = records.filter((a) => a.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new GenomeExportError(
      `${byName.length} agents are named '${ref}'`,
      `Pass one of their ids instead: ${byName.map((a) => a.id).join(", ")}`,
    );
  }
  throw new GenomeExportError(`Agent '${ref}' not found`, "List local agents: rotifer agent list");
}

// ── Composition ──────────────────────────────────────────────

/** Rust executor CompareOp (what `agent run` accepts) → §15.2 CompareOp. */
export const COMPARE_OPS: Readonly<Record<string, CompareOp>> = {
  Eq: "EQ",
  Neq: "NEQ",
  Gt: "GT",
  Gte: "GTE",
  Lt: "LT",
  Lte: "LTE",
  Contains: "CONTAINS",
  Matches: "MATCHES",
};

type LocalComposition = {
  type?: string;
  merge?: string;
  predicate?: { field?: string; op?: string; value?: unknown; equals?: unknown };
};

/** Composition type exactly as `agent run` derives it. */
export function compositionTypeOf(agent: AgentRecord): string {
  const comp = agent.composition as unknown;
  const declared = typeof comp === "object" && comp !== null ? (comp as LocalComposition).type : comp;
  return (typeof declared === "string" && declared) || (agent.genome.length >= 2 ? "Seq" : "Single");
}

function outsideSubset(type: string, why: string): GenomeExportError {
  return new GenomeExportError(
    `Composition '${type}' cannot be exported: ${why}`,
    "v0.9.2 exports only what 'rotifer agent run' executes faithfully: " +
      "Single (1 gene), Seq, Par (2+ genes), Cond and Try (exactly 2 genes).",
  );
}

/**
 * Map the agent's composition onto §15.2, limited to what `agent run` executes:
 * branches are single genes, Par/Cond/Try take the genome in order. Anything
 * else fails rather than being approximated.
 */
export function buildComposition(
  agent: AgentRecord,
  refs: GeneReference[],
): { composition: AlgebraExpr; parMerge?: string } {
  const type = compositionTypeOf(agent);
  const comp = (typeof agent.composition === "object" ? agent.composition : {}) as LocalComposition;
  const leaf = (i: number): AlgebraExpr => ({ Gene: { geneRef: refs[i] } });
  const n = refs.length;

  switch (type) {
    case "Single":
      if (n !== 1) throw outsideSubset(type, `needs exactly 1 gene, the genome has ${n}`);
      return { composition: leaf(0) };
    case "Seq":
      if (n < 1) throw outsideSubset(type, "the genome is empty");
      return { composition: { Seq: { steps: refs.map((_, i) => leaf(i)) } } };
    case "Par": {
      if (n < 2) throw outsideSubset(type, `needs at least 2 genes, the genome has ${n}`);
      // Right-associative: [a, b, c] → Par(a, Par(b, c)). No deadline — `agent run` has none.
      let expr = leaf(n - 1);
      for (let i = n - 2; i >= 0; i--) expr = { Par: { left: leaf(i), right: expr } };
      return { composition: expr, parMerge: comp.merge || "first" };
    }
    case "Cond": {
      if (n !== 2) throw outsideSubset(type, `needs exactly 2 genes, the genome has ${n}`);
      // Same defaults `agent run` applies to a missing predicate.
      const pred = comp.predicate ?? {};
      const op = pred.op || "Eq";
      const operator = COMPARE_OPS[op];
      if (!operator) {
        throw outsideSubset(type, `unknown predicate operator '${op}' (expected one of ${Object.keys(COMPARE_OPS).join(", ")})`);
      }
      return {
        composition: {
          Cond: {
            predicate: { field: pred.field || "type", operator, value: pred.value ?? pred.equals ?? "primary" },
            ifTrue: leaf(0),
            ifFalse: leaf(1),
          },
        },
      };
    }
    case "Try":
      if (n !== 2) throw outsideSubset(type, `needs exactly 2 genes, the genome has ${n}`);
      return { composition: { TryCatch: { body: leaf(0), handler: leaf(1) } } };
    default:
      throw outsideSubset(type, "§15.2 has no such operator, or it is outside the v0.9.2 executable subset");
  }
}

// ── Blueprint assembly ───────────────────────────────────────

export interface BuildBlueprintInput {
  root: string;
  genesDir: string;
  agent: AgentRecord;
  lock?: boolean;
  minFitness?: number;
  minVg?: number;
  description?: string;
  author?: string;
  now?: Date;
}

export interface BuildBlueprintResult {
  blueprint: GenomeBlueprint;
  roles: RoleSummary[];
  notices: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hintForUncomputableId(gene: string, reason: string): string {
  if (/ir\.wasm|rotifer\.version|rotifer\.constraints/.test(reason)) {
    return `Compile it first: rotifer compile ${gene}`;
  }
  if (/fidelity/.test(reason)) return `Re-wrap it so phenotype.json declares a fidelity: rotifer wrap ${gene}`;
  return "See docs/gene-id-v2.md §5 for what makes a gene ID computable.";
}

function checkUnitInterval(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new GenomeExportError(`${name} must be a number between 0 and 1`);
  }
}

export function buildBlueprint(input: BuildBlueprintInput): BuildBlueprintResult {
  const { root, genesDir, agent } = input;
  const genesRoot = join(root, genesDir);
  const notices: string[] = [];

  checkUnitInterval("--min-fitness", input.minFitness);
  if (input.minVg !== undefined) {
    if (!Number.isFinite(input.minVg) || input.minVg < MIN_VG_FLOOR || input.minVg >= 1) {
      throw new GenomeExportError(
        `--min-vg must be in [${MIN_VG_FLOOR}, 1.0)`,
        "§5.1 does not allow a V(g) threshold below 0.5.",
      );
    }
  }

  if (!Array.isArray(agent.genome) || agent.genome.length === 0) {
    throw new GenomeExportError(`Agent '${agent.name}' has an empty genome`);
  }
  const seen = new Set<string>();
  for (const gene of agent.genome) {
    if (seen.has(gene)) {
      throw new GenomeExportError(
        `Gene '${gene}' appears more than once in the genome`,
        "A Blueprint keys each role by gene name, so every gene can appear only once.",
      );
    }
    seen.add(gene);
  }

  const refs: GeneReference[] = [];
  const roles: RoleSummary[] = [];
  const capabilities: Record<string, CapabilityQuery> = {};
  const hints: Record<string, ResolutionHint> = {};

  for (const gene of agent.genome) {
    try {
      validateGeneName(gene);
    } catch (err) {
      throw new GenomeExportError((err as Error).message);
    }
    const geneDir = join(genesRoot, gene);
    const phenotype = readJson(join(geneDir, "phenotype.json"));
    if (!phenotype) {
      throw new GenomeExportError(
        `Gene '${gene}' has no readable phenotype.json under ${genesDir}/`,
        `Install or wrap it first: rotifer install ${gene}  or  rotifer wrap ${gene}`,
      );
    }

    const idResult = geneIdV2(genesRoot, gene);
    if (!("id" in idResult)) {
      throw new GenomeExportError(
        `Gene '${gene}' has no v2 gene ID: ${idResult.reason}`,
        hintForUncomputableId(gene, idResult.reason),
      );
    }
    if (!GENE_ID_V2.test(idResult.id)) {
      throw new GenomeExportError(`Gene '${gene}' got a malformed v2 gene ID from the native module`);
    }

    refs.push({ geneId: idResult.id, role: gene, optional: false });

    const fidelity = typeof phenotype.fidelity === "string" ? phenotype.fidelity : "";
    const isWrapped = fidelity.toLowerCase() === "wrapped";

    if (!input.lock) {
      if (typeof phenotype.domain === "string" && phenotype.domain) {
        capabilities[gene] = {
          domain: phenotype.domain,
          inputSchemaCompat: phenotype.inputSchema ?? {},
          outputSchemaCompat: phenotype.outputSchema ?? {},
          minFitness: input.minFitness ?? DEFAULT_MIN_FITNESS,
        };
      } else {
        notices.push(`Gene '${gene}' declares no domain — the receiver can only import it by gene ID.`);
      }
    }

    const manifest = readJson(join(geneDir, ".cloud-manifest.json"));
    const owner = manifest?.owner;
    const version = manifest?.version;
    let hasHints = false;
    if (typeof owner === "string" && owner && typeof version === "string" && version && fidelity) {
      hints[gene] = {
        owner,
        name: gene,
        version,
        ...(typeof manifest?.cloud_id === "string" && manifest.cloud_id ? { cloudId: manifest.cloud_id } : {}),
        fidelity,
      };
      hasHints = true;
    } else {
      notices.push(
        input.lock
          ? `Gene '${gene}' was never published or installed from the Registry — the receiver has no way to fetch it.`
          : `Gene '${gene}' was never published or installed from the Registry — the receiver can only find a substitute by capability.`,
      );
    }

    if (isWrapped) {
      notices.push(
        `Gene '${gene}' is Wrapped: in v0.9.2 the receiver cannot install Wrapped genes from the Registry ` +
          "(their source is not distributed there), only find a Native/Hybrid substitute by capability.",
      );
    }

    roles.push({ role: gene, geneId: idResult.id, fidelity, hasHints });
  }

  const { composition, parMerge } = buildComposition(agent, refs);

  const extension: Record<string, unknown> = {};
  if (parMerge !== undefined) extension.parMerge = parMerge;
  if (input.minVg !== undefined) extension.minVg = input.minVg;

  const now = (input.now ?? new Date()).toISOString();
  const blueprint: GenomeBlueprint = {
    blueprintFormat: BLUEPRINT_FORMAT,
    protocolVersion: { ...BLUEPRINT_PROTOCOL_VERSION, supportedFeatures: ["GENE_COMPOSITION_ALGEBRA"] },
    snapshot: { genes: refs, composition, snapshotAt: now },
    metadata: {
      name: agent.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.author ? { author: input.author } : {}),
      createdAt: now,
    },
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(Object.keys(hints).length > 0 ? { resolutionHints: hints } : {}),
    ...(Object.keys(extension).length > 0 ? { bindingExtensions: { [BINDING_NAME]: extension } } : {}),
  };

  return { blueprint, roles, notices };
}

// ── Credential scan ──────────────────────────────────────────
//
// Three layers over every key and string of the Blueprint (§5.1 rule S-01):
// key names, value shapes, entropy. A hit aborts the export; findings carry the
// JSON Pointer and the rule, never the value.

export type CredentialLayer = "key-name" | "value-pattern" | "entropy";

export interface CredentialFinding {
  pointer: string;
  layer: CredentialLayer;
  rule: string;
}

/** Field names that hold a credential. Matched after lower-casing and dropping `_`/`-`, as the whole name or its suffix. */
export const CREDENTIAL_KEY_NAMES: readonly string[] = [
  "apiKey",
  "password",
  "privateKey",
  "secret",
  "token",
  "bearer",
  "accessToken",
  "clientSecret",
  "refreshToken",
  "oauth_token",
  "aws_secret_access_key",
  "stripe_secret_key",
];

const NORMALIZED_KEY_NAMES = CREDENTIAL_KEY_NAMES.map(normalizeKey);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCredentialKeyName(key: string): boolean {
  const k = normalizeKey(key);
  return NORMALIZED_KEY_NAMES.some((name) => k === name || k.endsWith(name));
}

/** A bare 32-byte key in hex: exactly 64 hex characters, optionally `0x`-prefixed. */
const BARE_HEX_KEY = /(?<![0-9A-Fa-f])(?:0x)?[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/;

/** A `/`-separated run of plain words ("docs/protocol/genome") — prose, not key material. */
const PATH_WORD = /^[A-Za-z][a-z]*[0-9]*$/;

function isPathLike(run: string): boolean {
  const segments = run.split("/");
  return segments.length >= 2 && segments.every((s) => s.length >= 2 && PATH_WORD.test(s));
}

/**
 * A bare 32- or 64-byte key in Base64 outside a PEM block: a Base64 run of
 * 43–44 or 86–88 characters that also looks random. Letters and `/` are in the
 * Base64 alphabet, so length and charset alone also catch path text; random
 * key material is told apart by its entropy (over 200,000 random keys the
 * lowest seen was 4.24 bits/char at 32 bytes and 4.88 at 64; one million of
 * each all still matched this rule) and by not splitting into plain words on `/`.
 */
function hasBareBase64Key(value: string): boolean {
  for (const run of value.match(/[A-Za-z0-9+/=]+/g) ?? []) {
    const body = run.replace(/={1,2}$/, "");
    if (body.includes("=")) continue;
    const len = run.length;
    const isKey32 = len >= 43 && len <= 44;
    const isKey64 = len >= 86 && len <= 88;
    if (!isKey32 && !isKey64) continue;
    if (shannonEntropy(body) < (isKey32 ? 4.0 : 4.5)) continue;
    if (isPathLike(body)) continue;
    return true;
  }
  return false;
}

export const BARE_HEX_RULE = "Bare 32-byte hex key";
const BARE_BASE64_RULE = "Bare Base64 key (32/64 bytes)";

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const ENTROPY_THRESHOLD = 4.5;
const ENTROPY_MIN_LENGTH = 20;

/** RFC 6901 escaping of one reference token. */
function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Scan one string. `isHexExempt` lifts only the bare-hex rule — for fields that
 * legitimately hold a hash; every other rule still applies.
 */
function scanString(value: string, pointer: string, isHexExempt: boolean, out: CredentialFinding[]): void {
  for (const { label, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) out.push({ pointer, layer: "value-pattern", rule: label });
  }
  if (!isHexExempt && BARE_HEX_KEY.test(value)) {
    out.push({ pointer, layer: "value-pattern", rule: BARE_HEX_RULE });
  }
  if (hasBareBase64Key(value)) out.push({ pointer, layer: "value-pattern", rule: BARE_BASE64_RULE });

  // Per whitespace-separated token, so ordinary prose does not add up to a hit.
  // Hex tops out at 4.0 bits/char and never trips this — the hex rule above covers it.
  for (const token of value.split(/\s+/)) {
    if (token.length > ENTROPY_MIN_LENGTH && shannonEntropy(token) > ENTROPY_THRESHOLD) {
      out.push({ pointer, layer: "entropy", rule: `High-entropy string (> ${ENTROPY_THRESHOLD} bits/char)` });
      break;
    }
  }
}

/** A number array of key length (32 or 64 entries, each a byte) — key material stored as bytes. */
function isKeyLengthByteArray(node: unknown[]): boolean {
  return (node.length === 32 || node.length === 64) && node.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255);
}
const BYTE_ARRAY_RULE = "Byte array of key length (32/64)";

/** A value a credential-named field could hold: a non-empty string, a number, or a list of those. */
function holdsCredentialValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number" || typeof v === "string");
}

/**
 * Code a Blueprint must not carry (it holds references and public fields only).
 * Checked only where free-form binding data lives, so prose like "calls the
 * function" in a description is not mistaken for code.
 */
const CODE_SHAPE =
  /\breturn\b[^;\n]*;|=>|\bfunction\b\s*[\w$]*\s*\(|\b(?:eval|require|Function|setTimeout|setInterval|fetch)\s*\(|<script\b|^\s*import\s|\bmodule\.exports\b/;
const CODE_RULE = "Code in extension field";

export interface ScanOptions {
  /** Positions that may hold a 64-hex hash; only the bare-hex rule is lifted there. */
  isHexExempt?: (pointer: string, value: string) => boolean;
  /** Positions whose strings must not look like code. */
  isCodeForbidden?: (pointer: string) => boolean;
}

/**
 * Scan any JSON value.
 *
 * Pointers are built for humans to find the problem, so they must not become
 * the leak: an object key that itself looks like a credential is replaced by
 * `<redacted key #i>` (i = its position among that object's keys) in its own
 * pointer and in every pointer below it.
 */
export function scanForCredentials(doc: unknown, options: ScanOptions = {}): CredentialFinding[] {
  const isHexExempt = options.isHexExempt ?? (() => false);
  const isCodeForbidden = options.isCodeForbidden ?? (() => false);
  const out: CredentialFinding[] = [];

  const walk = (node: unknown, pointer: string): void => {
    if (typeof node === "string") {
      scanString(node, pointer, isHexExempt(pointer, node), out);
      if (isCodeForbidden(pointer) && CODE_SHAPE.test(node)) out.push({ pointer, layer: "value-pattern", rule: CODE_RULE });
      return;
    }
    if (Array.isArray(node)) {
      if (isKeyLengthByteArray(node)) out.push({ pointer, layer: "value-pattern", rule: BYTE_ARRAY_RULE });
      node.forEach((item, i) => walk(item, `${pointer}/${i}`));
      return;
    }
    if (node === null || typeof node !== "object") return;

    Object.entries(node as Record<string, unknown>).forEach(([key, value], index) => {
      // Map keys (roles, schema properties, extension names) are content too.
      const keyFindings: CredentialFinding[] = [];
      scanString(key, "", false, keyFindings);
      const isSecretKey = keyFindings.length > 0;
      const token = isSecretKey ? `<redacted key #${index}>` : pointerToken(key);
      const child = `${pointer}/${token}`;
      for (const f of keyFindings) out.push({ ...f, pointer: child });

      // A key that names a credential only counts when it holds one: a schema
      // declaring an `apiKey` parameter (an object) is not a leak.
      if (isCredentialKeyName(key) && holdsCredentialValue(value)) {
        out.push({ pointer: child, layer: "key-name", rule: `Credential field name ${isSecretKey ? token : `'${key}'`}` });
      }
      walk(value, child);
    });
  };

  walk(doc, "");

  const seen = new Set<string>();
  return out.filter((f) => {
    const id = `${f.pointer}\u0000${f.layer}\u0000${f.rule}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const GENES_GENE_ID = /^\/snapshot\/genes\/\d+\/geneId$/;
const EXCLUDED_GENE_ID = /^\/capabilities\/[^/]+\/excludeGeneIds\/\d+$/;
const COMPOSITION_GENE_ID = /^\/snapshot\/composition(?:\/[^/]+)*\/geneRef\/geneId$/;

/**
 * Scan a Blueprint. The bare-hex rule is lifted only where a gene ID belongs,
 * and only for a value shaped like one (`v2:` + 64 lowercase hex):
 * `/snapshot/genes/N/geneId`, `/capabilities/ROLE/excludeGeneIds/N`, and a
 * composition leaf's `geneRef/geneId` when it repeats an ID from
 * `snapshot.genes`. The same hex anywhere else is blocked. Strings under
 * `bindingExtensions` must not look like code.
 */
export function scanBlueprint(blueprint: GenomeBlueprint): CredentialFinding[] {
  const listed = new Set(
    (blueprint.snapshot?.genes ?? []).map((g) => g.geneId).filter((id) => GENE_ID_V2.test(id)),
  );
  return scanForCredentials(blueprint, {
    isHexExempt: (pointer, value) => {
      if (!GENE_ID_V2.test(value)) return false;
      if (GENES_GENE_ID.test(pointer) || EXCLUDED_GENE_ID.test(pointer)) return true;
      return COMPOSITION_GENE_ID.test(pointer) && listed.has(value);
    },
    isCodeForbidden: (pointer) => pointer.startsWith("/bindingExtensions/"),
  });
}

// ── Export ───────────────────────────────────────────────────

export interface ExportGenomeInput extends BuildBlueprintInput {
  output: string;
}

export interface ExportGenomeResult {
  file: string;
  agent: string;
  composition: string;
  geneCount: number;
  mode: "capability" | "lock";
  roles: RoleSummary[];
  notices: string[];
  credentialScan: { passed: true; layers: CredentialLayer[] };
}

/** Build, scan, and write a Blueprint. Nothing is written when the scan finds anything. */
export function exportGenome(input: ExportGenomeInput): ExportGenomeResult {
  const { blueprint, roles, notices } = buildBlueprint(input);

  const findings = scanBlueprint(blueprint);
  if (findings.length > 0) {
    throw new GenomeExportError(
      `Credential scan blocked the export: ${findings.length} finding(s); nothing was written`,
      "Remove the flagged values (shown by position only) and export again.",
      findings,
    );
  }

  writeFileSync(input.output, JSON.stringify(blueprint, null, 2) + "\n");

  return {
    file: input.output,
    agent: input.agent.name,
    composition: compositionTypeOf(input.agent),
    geneCount: blueprint.snapshot.genes.length,
    mode: blueprint.capabilities ? "capability" : "lock",
    roles,
    notices,
    credentialScan: { passed: true, layers: ["key-name", "value-pattern", "entropy"] },
  };
}

// ── CLI ──────────────────────────────────────────────────────

export interface GenomeExportOptions {
  output?: string;
  lock?: boolean;
  minFitness?: string;
  minVg?: string;
  description?: string;
}

function parseNumberOption(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new GenomeExportError(`${flag} must be a number, got '${raw}'`);
  return n;
}

function reportFailure(err: GenomeExportError): void {
  if (display.isJsonMode()) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: err.message, hint: err.hint, findings: err.findings }, null, 2) + "\n",
    );
    return;
  }
  display.error(err.message, err.hint);
  for (const f of err.findings ?? []) {
    console.error(`    ${f.pointer || "/"}  [${f.layer}] ${f.rule}`);
  }
}

/** Run `genome export`; returns the process exit code. */
export function runGenomeExport(
  agentRef: string,
  options: GenomeExportOptions,
  ctx: { root: string; genesDir: string; author?: string },
): number {
  try {
    const agent = findAgent(ctx.root, agentRef);
    const output = resolve(options.output ?? `${agent.name}.rgenome`);
    const result = exportGenome({
      root: ctx.root,
      genesDir: ctx.genesDir,
      agent,
      lock: options.lock,
      minFitness: parseNumberOption("--min-fitness", options.minFitness),
      minVg: parseNumberOption("--min-vg", options.minVg),
      description: options.description,
      author: ctx.author,
      output,
    });

    display.renderResult({ ok: true, ...result }, (r) => {
      display.header("Genome Export");
      display.keyValue("Agent", r.agent);
      display.keyValue("Composition", r.composition);
      display.keyValue("Mode", r.mode === "lock" ? "lock (gene IDs only)" : "capability + gene IDs");
      for (const role of r.roles) {
        display.keyValue(`  ${role.role}`, `${role.geneId}  ${role.fidelity}${role.hasHints ? "" : "  (no Registry hints)"}`);
      }
      for (const n of r.notices) display.warn(n);
      display.success("Credential scan passed (key names, value patterns, entropy)");
      display.success(`Wrote ${r.file}`);
    });
    return 0;
  } catch (err) {
    if (err instanceof GenomeExportError) {
      reportFailure(err);
      return 1;
    }
    throw err;
  }
}

const genomeExportCommand = new Command("export")
  .description("Export an agent's genome as a shareable Blueprint (.rgenome)")
  .argument("<agent>", "agent name or id")
  .option("-o, --output <file>", "output file (default: <agent>.rgenome)")
  .option("--lock", "reference genes by ID only; write no capability queries")
  .option("--min-fitness <n>", `minimum fitness in each capability query (default: ${DEFAULT_MIN_FITNESS})`)
  .option("--min-vg <n>", `suggested minimum V(g) for importers, in [${MIN_VG_FLOOR}, 1.0)`)
  .option("-d, --description <text>", "description stored in the Blueprint metadata")
  .action((agentRef: string, options: GenomeExportOptions) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);
    const author = loadCredentials()?.user?.username;
    process.exitCode = runGenomeExport(agentRef, options, { root, genesDir: config.genes_dir, author });
  });

export const genomeCommand = new Command("genome")
  .description("Genome Blueprint commands: export an agent's genome, import one")
  .addCommand(genomeExportCommand);
