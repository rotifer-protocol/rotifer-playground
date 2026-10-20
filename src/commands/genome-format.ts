/**
 * The Genome Blueprint format (.rgenome) as both ends see it: constants and
 * types, the credential scan, and the reader's validation. The writer
 * (genome.ts) runs the same validation on every file before writing it, so an
 * export always imports with the same CLI; the reader (genome-import.ts) runs
 * it before resolving anything.
 */
import { SENSITIVE_PATTERNS } from "../publish/pre-publish-check.js";

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

  // Per run of printable ASCII: credentials are printable ASCII, so whitespace
  // and any other character end a token. Prose does not add up to a hit, and
  // text without spaces — Chinese, or ASCII words joined by symbols like "≥" —
  // is not one long high-entropy token; a key glued to such text is still
  // judged on its own. Hex tops out at 4.0 bits/char and never trips this —
  // the hex rule above covers it.
  for (const token of value.match(/[\x21-\x7e]+/g) ?? []) {
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

/** Whether a string, on its own, trips any value rule — for masking it wherever it is about to be printed. */
export function looksLikeCredential(text: string): boolean {
  const out: CredentialFinding[] = [];
  scanString(text, "", false, out);
  return out.length > 0;
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
export interface ScanBlueprintOptions {
  /**
   * Import only: a composition gene ID is exempt from the bare-hex rule only at
   * a real leaf of the §15.2 subset (what the structural check reads), not at
   * any path that merely ends in `geneRef/geneId` — extra fields inside a Gene
   * body would otherwise smuggle a `v2:`-prefixed key past the scan. Export
   * builds the composition itself and keeps its rule.
   */
  isLeafPositionExact?: boolean;
}

/** Pointers of the `geneRef/geneId` of every real leaf in a §15.2 subset composition. */
export function compositionLeafIdPointers(expr: unknown, base = "/snapshot/composition"): Set<string> {
  const out = new Set<string>();
  const body = (node: unknown, tag: string): Record<string, unknown> | null => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
    const keys = Object.keys(node);
    if (keys.length !== 1 || keys[0] !== tag) return null;
    const b = (node as Record<string, unknown>)[tag];
    return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  };
  const visit = (node: unknown, at: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const [tag] = Object.keys(node);
    const b = body(node, tag);
    if (!b) return;
    switch (tag) {
      case "Gene":
        out.add(`${at}/Gene/geneRef/geneId`);
        break;
      case "Seq":
        if (Array.isArray(b.steps)) b.steps.forEach((step, i) => visit(step, `${at}/Seq/steps/${i}`));
        break;
      case "Par":
        visit(b.left, `${at}/Par/left`);
        visit(b.right, `${at}/Par/right`);
        break;
      case "Cond":
        visit(b.ifTrue, `${at}/Cond/ifTrue`);
        visit(b.ifFalse, `${at}/Cond/ifFalse`);
        break;
      case "TryCatch":
        visit(b.body, `${at}/TryCatch/body`);
        visit(b.handler, `${at}/TryCatch/handler`);
        break;
    }
  };
  visit(expr, base);
  return out;
}

export function scanBlueprint(blueprint: GenomeBlueprint, options: ScanBlueprintOptions = {}): CredentialFinding[] {
  // Also called on unvalidated import input, so nothing about its shape is assumed.
  const snapshot = (blueprint as { snapshot?: { genes?: unknown; composition?: unknown } } | null)?.snapshot;
  const genes: unknown = snapshot?.genes;
  const listed = new Set(
    (Array.isArray(genes) ? genes : [])
      .map((g) => (typeof g === "object" && g !== null ? (g as { geneId?: unknown }).geneId : undefined))
      .filter((id): id is string => typeof id === "string" && GENE_ID_V2.test(id)),
  );
  const leafIds = options.isLeafPositionExact ? compositionLeafIdPointers(snapshot?.composition) : null;
  return scanForCredentials(blueprint, {
    isHexExempt: (pointer, value) => {
      if (!GENE_ID_V2.test(value)) return false;
      if (GENES_GENE_ID.test(pointer) || EXCLUDED_GENE_ID.test(pointer)) return true;
      const isLeafPosition = leafIds ? leafIds.has(pointer) : COMPOSITION_GENE_ID.test(pointer);
      return isLeafPosition && listed.has(value);
    },
    isCodeForbidden: (pointer) => pointer.startsWith("/bindingExtensions/"),
  });
}

const PAR_MERGES = new Set(["first", "concat", "merge"]);

export class GenomeImportError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "GenomeImportError";
  }
}

// ── 1. Parse and validate ────────────────────────────────────

/** What `agent create` needs to rebuild the composition. */
export interface CompositionPlan {
  type: "Single" | "Seq" | "Par" | "Cond" | "Try";
  /** Roles in execution order (= the agent's genome order). */
  roles: string[];
  parMerge?: string;
  predicate?: { field: string; op: string; value: unknown };
}

export interface ParsedBlueprint {
  blueprint: GenomeBlueprint;
  plan: CompositionPlan;
  /** The author's suggested V(g) threshold, if any. */
  suggestedMinVg?: number;
}

const OPS_FROM_SPEC: Record<string, string> = Object.fromEntries(
  Object.entries(COMPARE_OPS).map(([local, spec]) => [spec, local]),
);

function outsideSubset(why: string): GenomeImportError {
  return new GenomeImportError(
    `Composition is outside the v0.9.2 executable subset: ${why}`,
    "v0.9.2 imports Gene, Seq of genes, Par of genes (no deadline), and Cond/TryCatch over exactly two genes.",
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The single key of an externally tagged AlgebraExpr, and its body. */
function tagOf(expr: unknown): [string, Record<string, unknown>] {
  if (!isObject(expr)) throw outsideSubset("an expression is not an object");
  const keys = Object.keys(expr);
  if (keys.length !== 1) throw outsideSubset(`an expression has ${keys.length} tags`);
  const body = expr[keys[0]];
  if (!isObject(body)) throw outsideSubset(`'${keys[0]}' has no body`);
  return [keys[0], body];
}

/** A `Gene` leaf's role, checked against the snapshot's gene list. */
function leafRole(expr: unknown, genes: GeneReference[]): string {
  const [tag, body] = tagOf(expr);
  if (tag === "RemoteGene") throw outsideSubset("RemoteGene is not supported");
  if (tag !== "Gene") throw outsideSubset(`'${tag}' appears where only a single gene may`);
  const ref = body.geneRef;
  if (!isObject(ref) || typeof ref.role !== "string" || typeof ref.geneId !== "string") {
    throw outsideSubset("a Gene leaf has no geneRef { geneId, role }");
  }
  const listed = genes.find((g) => g.role === ref.role);
  if (!listed || listed.geneId !== ref.geneId) {
    throw new GenomeImportError(`Composition leaf '${ref.role}' does not match snapshot.genes`);
  }
  return ref.role;
}

export function compositionPlan(blueprint: GenomeBlueprint): CompositionPlan {
  const genes = blueprint.snapshot.genes;
  const order = genes.map((g) => g.role);
  const ext = blueprint.bindingExtensions?.[BINDING_NAME] ?? {};
  const expr = blueprint.snapshot.composition;

  // Format 1 requires the expression (RFC B3): §4.3's dataFlow fallback is
  // neither written nor read, so list order alone does not say what runs.
  if (expr === undefined) {
    throw new GenomeImportError(
      "Blueprint has no snapshot.composition",
      "Blueprint format 1 requires it; export the agent again with rotifer genome export.",
    );
  }

  const [tag, body] = tagOf(expr);
  let plan: CompositionPlan;
  switch (tag) {
    case "Gene":
      plan = { type: "Single", roles: [leafRole(expr, genes)] };
      break;
    case "Seq": {
      if (!Array.isArray(body.steps) || body.steps.length === 0) throw outsideSubset("Seq has no steps");
      plan = { type: "Seq", roles: body.steps.map((s) => leafRole(s, genes)) };
      break;
    }
    case "Par": {
      // `agent run` executes Par flat and n-ary; export writes it right-nested.
      // Flatten Par(a, Par(b, c)) back to [a, b, c]; anything else nested is refused.
      const roles: string[] = [];
      let node: Record<string, unknown> = body;
      for (;;) {
        if (node.deadline !== undefined && node.deadline !== null) throw outsideSubset("Par with a deadline");
        roles.push(leafRole(node.left, genes));
        const [rightTag, rightBody] = tagOf(node.right);
        if (rightTag === "Par") {
          node = rightBody;
          continue;
        }
        roles.push(leafRole(node.right, genes));
        break;
      }
      plan = { type: "Par", roles, parMerge: checkParMerge(ext.parMerge) };
      break;
    }
    case "Cond": {
      const p = body.predicate;
      if (!isObject(p) || typeof p.field !== "string" || typeof p.operator !== "string" || !("value" in p)) {
        throw outsideSubset("Cond predicate must be { field, operator, value }");
      }
      // agent run substitutes "type" for an empty field and "primary" for a null
      // value; accepting them would run a different branch than the one declared.
      if (p.field === "") throw outsideSubset("Cond predicate needs a non-empty field");
      if (p.value === null) throw outsideSubset("Cond predicate value must not be null");
      const op = OPS_FROM_SPEC[p.operator];
      if (!op) throw outsideSubset(`unknown CompareOp '${p.operator}'`);
      // What the executor actually does (R3): MATCHES always evaluates to false,
      // CONTAINS only tests substrings, and field is looked up as one top-level key.
      if (p.operator === "MATCHES") throw outsideSubset("Cond operator MATCHES is not executed by agent run (it always evaluates to false)");
      if (p.operator === "CONTAINS" && typeof p.value !== "string") {
        throw outsideSubset("Cond operator CONTAINS needs a string value; agent run only tests substrings");
      }
      if (/[./[\]]/.test(p.field)) {
        throw outsideSubset("Cond field must be a top-level field name (no '.', '/', '[' or ']'); agent run does not follow paths");
      }
      plan = {
        type: "Cond",
        roles: [leafRole(body.ifTrue, genes), leafRole(body.ifFalse, genes)],
        predicate: { field: p.field, op, value: p.value },
      };
      break;
    }
    case "TryCatch":
      plan = { type: "Try", roles: [leafRole(body.body, genes), leafRole(body.handler, genes)] };
      break;
    default:
      throw outsideSubset(`'${tag}' is not a §15.2 operator v0.9.2 supports`);
  }

  if (plan.roles.join("\u0000") !== order.join("\u0000")) {
    throw outsideSubset("the composition must use every gene of snapshot.genes once, in order");
  }
  return plan;
}

/** The Par merge strategy (RFC §2.6, on the §7 list): applied as defined, or the Blueprint is refused. */
function checkParMerge(value: unknown): string {
  const merge = value ?? "first";
  if (typeof merge !== "string" || !PAR_MERGES.has(merge)) {
    throw new GenomeImportError(`bindingExtensions["${BINDING_NAME}"].parMerge '${String(merge)}' is not first, concat or merge`);
  }
  return merge;
}

export function checkMinVg(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_VG_FLOOR || value >= 1) {
    throw new GenomeImportError(`${where} must be in [${MIN_VG_FLOOR}, 1.0)`, "§5.1 does not allow a V(g) threshold below 0.5.");
  }
  return value;
}

/**
 * The first number in the file that cannot be imported as written, with its
 * pointer. Keys are already scanned. Judged on the parsed value, whatever the
 * spelling: JSON.parse rounds an integer beyond 2^53 to a neighbour
 * (9007199254740993, ...993e0 and ...993.0 all become ...992), and rounding is
 * monotonic with 2^53 itself representable, so every such literal lands on an
 * integer outside the safe range — which is what is refused. Integer-valued
 * floats such as 1e20 are refused with them.
 */
function firstUnrepresentableNumber(node: unknown, pointer: string): { pointer: string; problem: string } | null {
  if (typeof node === "number") {
    if (!Number.isFinite(node)) return { pointer, problem: "a value that is not a finite number" };
    if (Number.isInteger(node) && !Number.isSafeInteger(node)) {
      return { pointer, problem: "an integer outside the exactly representable range" };
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = firstUnrepresentableNumber(node[i], `${pointer}/${i}`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      const hit = firstUnrepresentableNumber(value, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const BAD_KEY_TOKEN = "<key with an unpaired surrogate>";

function pointerTokenFor(key: string): string {
  if (UNPAIRED_SURROGATE.test(key)) return BAD_KEY_TOKEN;
  if (looksLikeCredential(key)) return "<redacted key>";
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Pointer of the first string (value or key) holding an unpaired UTF-16 surrogate, or null. */
function firstUnpairedSurrogate(node: unknown, pointer: string): string | null {
  if (typeof node === "string") return UNPAIRED_SURROGATE.test(node) ? pointer : null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = firstUnpairedSurrogate(node[i], `${pointer}/${i}`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (UNPAIRED_SURROGATE.test(key)) return `${pointer}/${BAD_KEY_TOKEN}`;
      const hit = firstUnpairedSurrogate(value, `${pointer}/${pointerTokenFor(key)}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Pointer of the first key that repeats within its object, or null. JSON.parse
 * keeps the last occurrence and leaves no trace, so this reads the source text.
 * It runs only after JSON.parse accepted the text, so the input is valid JSON;
 * keys are decoded with JSON.parse, so "a" and "\u0061" are the same key.
 */
function firstDuplicateKey(text: string): string | null {
  type Frame =
    | { kind: "object"; token: string; keys: Set<string>; isExpectingKey: boolean; currentKey: string }
    | { kind: "array"; token: string; index: number };
  const stack: Frame[] = [];
  const childToken = (): string => {
    const top = stack[stack.length - 1];
    if (!top) return "";
    return top.kind === "object" ? pointerTokenFor(top.currentKey) : String(top.index);
  };
  const pathTo = (key: string) => [...stack.slice(1).map((f) => f.token), pointerTokenFor(key)].map((t) => `/${t}`).join("");

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.kind === "object" && top.isExpectingKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return pathTo(key);
        top.keys.add(key);
        top.currentKey = key;
        top.isExpectingKey = false;
      }
      i = j;
    } else if (ch === "{") {
      stack.push({ kind: "object", token: childToken(), keys: new Set(), isExpectingKey: true, currentKey: "" });
    } else if (ch === "[") {
      stack.push({ kind: "array", token: childToken(), index: 0 });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.isExpectingKey = true;
      else if (top?.kind === "array") top.index++;
    }
  }
  return null;
}

/** Parse a Blueprint, keep only what v0.9.2 can rebuild faithfully, and run the credential scan. */
export function parseBlueprint(text: string): ParsedBlueprint {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // The parser's own message quotes the input around the error, which may be
    // a key; report only where it broke.
    const position = /position (\d+)/.exec((err as Error).message)?.[1];
    throw new GenomeImportError(`Not a JSON Blueprint: the file is not valid JSON${position ? ` (at position ${position})` : ""}`);
  }
  if (!isObject(raw)) throw new GenomeImportError("Not a Blueprint: the top level is not an object");

  // The credential scan runs before any structural check: structural errors
  // name roles, keys and values from the file, and none of those may be a
  // secret by the time they are printed. Findings carry masked pointers only.
  const findings = scanBlueprint(raw as unknown as GenomeBlueprint, { isLeafPositionExact: true });
  if (findings.length > 0) {
    const where = findings.map((f) => `${f.pointer || "/"} [${f.layer}] ${f.rule}`).join("; ");
    throw new GenomeImportError(`The Blueprint carries what looks like a credential, so it is not imported: ${where}`);
  }

  // A number must import as written. JSON.parse reads 1e400 as Infinity (saved
  // again it becomes null, and agent run substitutes a default) and rounds an
  // integer beyond 2^53 to a neighbour — either can switch a Cond branch.
  const unrepresentable = firstUnrepresentableNumber(raw, "");
  if (unrepresentable !== null) {
    throw new GenomeImportError(
      `The Blueprint has ${unrepresentable.problem} at ${unrepresentable.pointer || "/"}`,
      "Numbers must be finite, and integers within ±(2^53 − 1); write larger values as strings.",
    );
  }

  // Canonical JSON (RFC 8785) cannot represent either of these, and the genome ID
  // is computed over canonical JSON: refuse them before anything else is decided.
  const surrogate = firstUnpairedSurrogate(raw, "");
  if (surrogate !== null) {
    throw new GenomeImportError(`The Blueprint has a string with an unpaired surrogate at ${surrogate || "/"}`);
  }
  const duplicate = firstDuplicateKey(text);
  if (duplicate !== null) {
    throw new GenomeImportError(
      `The Blueprint has a duplicate key at ${duplicate}`,
      "JSON.parse would silently keep the last one; write each key once.",
    );
  }

  const format = raw.blueprintFormat;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    throw new GenomeImportError("Not a Blueprint: blueprintFormat is missing or not a positive integer");
  }
  if (format > BLUEPRINT_FORMAT) {
    throw new GenomeImportError(
      `Blueprint format ${format} is newer than this CLI understands (${BLUEPRINT_FORMAT})`,
      "Update the CLI: rotifer self-update",
    );
  }

  // RFC §2.1 (B5): every MUST field, with the shape §2.7 gives it. protocolVersion
  // is informational (B6): its shape is checked, its value never gates anything.
  const pv = raw.protocolVersion;
  const isVersionPart = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (
    !isObject(pv) ||
    !["major", "minor", "patch"].every((k) => isVersionPart(pv[k])) ||
    !Array.isArray(pv.supportedFeatures) ||
    !pv.supportedFeatures.every((f) => typeof f === "string")
  ) {
    throw new GenomeImportError(
      "Not a Blueprint: protocolVersion must be { major, minor, patch, supportedFeatures } with non-negative integers and a list of strings",
    );
  }
  const metadata = raw.metadata;
  if (!isObject(metadata) || typeof metadata.createdAt !== "string") {
    throw new GenomeImportError("Not a Blueprint: metadata.createdAt is missing or not a string");
  }
  for (const key of ["name", "description", "author"]) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "string") {
      throw new GenomeImportError(`metadata.${key} must be a string`);
    }
  }

  const snapshot = raw.snapshot;
  if (!isObject(snapshot) || !Array.isArray(snapshot.genes) || snapshot.genes.length === 0) {
    throw new GenomeImportError("Blueprint has no snapshot.genes");
  }
  if (typeof snapshot.snapshotAt !== "string") {
    throw new GenomeImportError("Not a Blueprint: snapshot.snapshotAt is missing or not a string");
  }
  const roles = new Set<string>();
  for (const g of snapshot.genes) {
    if (!isObject(g) || typeof g.geneId !== "string" || typeof g.role !== "string" || g.role === "") {
      throw new GenomeImportError("Every snapshot.genes entry needs a geneId and a role");
    }
    if (!GENE_ID_V2.test(g.geneId)) throw new GenomeImportError(`Gene '${g.role}' has no v2 gene ID`);
    if (typeof g.optional !== "boolean") throw new GenomeImportError(`Gene '${g.role}' needs optional: true or false`);
    if (g.optional === true) throw outsideSubset(`gene '${g.role}' is optional, which agent run has no notion of`);
    if (roles.has(g.role)) throw new GenomeImportError(`Role '${g.role}' appears twice in snapshot.genes`);
    roles.add(g.role);
  }

  if (raw.capabilities !== undefined) {
    if (!isObject(raw.capabilities)) throw new GenomeImportError("capabilities must be an object");
    for (const [role, q] of Object.entries(raw.capabilities)) {
      if (!roles.has(role)) throw new GenomeImportError(`capabilities has a role '${role}' that snapshot.genes lacks`);
      if (!isObject(q) || typeof q.domain !== "string" || q.domain === "") {
        throw new GenomeImportError(`capabilities['${role}'] has no domain`);
      }
      for (const key of ["inputSchemaCompat", "outputSchemaCompat"]) {
        if (q[key] === undefined) throw new GenomeImportError(`capabilities['${role}'] has no ${key}`);
      }
      if (typeof q.minFitness !== "number" || q.minFitness < 0 || q.minFitness > 1) {
        throw new GenomeImportError(`capabilities['${role}'].minFitness must be a number between 0 and 1`);
      }
      if (q.excludeGeneIds !== undefined) {
        if (!Array.isArray(q.excludeGeneIds) || !q.excludeGeneIds.every((id) => typeof id === "string" && GENE_ID_V2.test(id))) {
          throw new GenomeImportError(`capabilities['${role}'].excludeGeneIds must be v2 gene IDs`);
        }
      }
    }
  }

  if (raw.resolutionHints !== undefined) {
    if (!isObject(raw.resolutionHints)) throw new GenomeImportError("resolutionHints must be an object");
    for (const [role, h] of Object.entries(raw.resolutionHints)) {
      if (!roles.has(role)) throw new GenomeImportError(`resolutionHints has a role '${role}' that snapshot.genes lacks`);
      const isValid =
        isObject(h) &&
        ["owner", "name", "version", "fidelity"].every((k) => typeof h[k] === "string" && h[k] !== "") &&
        (h.cloudId === undefined || typeof h.cloudId === "string");
      if (!isValid) throw new GenomeImportError(`resolutionHints['${role}'] needs owner, name, version and fidelity`);
    }
  }

  if (raw.bindingExtensions !== undefined) {
    if (!isObject(raw.bindingExtensions)) throw new GenomeImportError("bindingExtensions must be an object");
    for (const [binding, value] of Object.entries(raw.bindingExtensions)) {
      if (!isObject(value)) throw new GenomeImportError(`bindingExtensions['${binding}'] must be an object`);
    }
  }

  const blueprint = raw as unknown as GenomeBlueprint;
  // The §7 list (parMerge, minVg): apply as defined or refuse; checked whenever written.
  const ext = blueprint.bindingExtensions?.[BINDING_NAME];
  if (ext?.parMerge !== undefined) checkParMerge(ext.parMerge);
  const suggestedMinVg = ext?.minVg === undefined ? undefined : checkMinVg(ext.minVg, `bindingExtensions["${BINDING_NAME}"].minVg`);

  const plan = compositionPlan(blueprint);

  return { blueprint, plan, suggestedMinVg };
}

