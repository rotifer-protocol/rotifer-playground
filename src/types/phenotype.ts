/**
 * Phenotype type definitions — v0.9.1 §3.3 (ADR-253 D4.4 + ADR-277 D7 L3).
 *
 * Single source of truth for Phenotype field schemas in TypeScript. The
 * runtime validator (`utils/phenotype-validator.ts`) imports the const
 * arrays from here so the enum surface stays in sync between type-check
 * time and runtime validation.
 *
 * Spec alignment: §4.2 RotiferGeneSpec. The `executionModel` field is
 * pending L2 Spec Patch (Tier 2) — track via Plan §3.3.
 */

// ─── ExecutionModel (v0.9.1 §3.3, ADR-253 D4.4) ──────────────────────────────

/**
 * Declares how a Gene is consumed at runtime.
 *
 * - `CHAT`: Conversational Agent (chat URL surface applies — rotifer.ai
 *   `/agents/[creator]/[name]` renders a chat interface).
 * - `BATCH`: Synchronous function-call style invocation. Default for legacy
 *   v0.8.x Genes that pre-date this enum.
 * - `EVENT_DRIVEN`: Triggered by external events (cron, webhook, message).
 *
 * Absent field is treated as `BATCH` at runtime for backward compatibility
 * with pre-§3.3 published Genes.
 */
export type ExecutionModel = "CHAT" | "BATCH" | "EVENT_DRIVEN";

export const EXECUTION_MODELS: readonly ExecutionModel[] = [
  "CHAT",
  "BATCH",
  "EVENT_DRIVEN",
] as const;

// ─── SynthesisMethod (ADR-087 D2) ────────────────────────────────────────────

export type SynthesisMethod =
  | "MANUAL"
  | "LLM_ASSISTED"
  | "LLM_AUTO"
  | "MUTATION"
  | "DE_NOVO";

export const SYNTHESIS_METHODS: readonly SynthesisMethod[] = [
  "MANUAL",
  "LLM_ASSISTED",
  "LLM_AUTO",
  "MUTATION",
  "DE_NOVO",
] as const;

// ─── Fidelity (Spec §4) ──────────────────────────────────────────────────────

export type Fidelity = "Wrapped" | "Hybrid" | "Native" | "Unknown";

// ─── Hybrid Fidelity (Spec §4.2 v2.11 + §3.11 v0.9 plan + ADR-220) ───────────

/**
 * FIDELITY_DISCOUNT — protocol parameter (spec §5.1 v2.11).
 *
 * Multiplied into F(g) so that Native, Hybrid, and Wrapped genes can compete
 * on a single Arena ranking without privileging external-API-shaped genes.
 *
 *   F(g) = base_fitness × FIDELITY_DISCOUNT[gene.fidelity]
 *
 * Keys are the lowercase canonical form (Q2=c 2026-05-28 — case
 * normalization between spec enum (UPPER) and runtime keys (lower) is
 * deferred to Phase 5 / v0.9.1; current binding implementations should
 * normalize via lowercasing before lookup).
 *
 * PAP minor adjustment: Δ ≤ 0.05 per discount tier per cycle (spec §14.6).
 */
export const FIDELITY_DISCOUNT: Readonly<Record<string, number>> = Object.freeze({
  native: 1.0,
  hybrid: 0.85,
  wrapped: 0.7,
});

/**
 * Semantic-layer external API dependency declaration.
 *
 * Complements the protocol-layer NetworkConfig — `network` declares the
 * sandbox's domain whitelist + timeouts, while `externalDependencies`
 * declares the *semantic* contract (what kind of service, expected SLA,
 * and degradation behavior).
 *
 * Spec §4.2 v2.11; v0.9 plan §3.11 (A2=b decision); ADR-220 §"D-04".
 */
export interface ExternalDependency {
  /** Protocol family — "rest" | "graphql" | "grpc" | "websocket". */
  apiType: string;
  /** Semantic identifier (e.g. "cve-database", "llm-judge", "git-cli"). */
  semanticTag: string;
  /** Optional expected SLA. */
  sla?: {
    expectedLatency?: number;
    expectedAvailability?: number;
  };
  /**
   * How the gene behaves when this dependency is unreachable — the
   * external-dependency axis (spec §4.2 `DegradationBehavior`), one of three
   * orthogonal degradation axes (ADR-220 E2, ADR-297): external-dependency
   * behavior ⊥ degradation mode (`DegradationSpec.mode`) ⊥ eventual failure
   * semantics. Mirrors the Rust IR `ExternalDependencyBehavior`. The legacy
   * PascalCase literals still validate with a deprecation warning through the
   * v0.9.1 grace window (see `LEGACY_DEGRADATION_BEHAVIORS`; removed v0.9.2).
   */
  degradationBehavior: ExternalDependencyBehavior;
}

/** Spec §4.2 `DegradationBehavior` — external-dependency unreachable behavior. */
export type ExternalDependencyBehavior = "FAIL" | "FALLBACK" | "CACHE" | "SKIP";

export const DEGRADATION_BEHAVIORS: readonly ExternalDependencyBehavior[] = [
  "FAIL",
  "FALLBACK",
  "CACHE",
  "SKIP",
] as const;

/**
 * Legacy `degradationBehavior` literals (the pre-§3.3 collapsed 5-variant set)
 * mapped to their spec replacement. Accepted with a deprecation warning through
 * the v0.9.1 grace window; removed in v0.9.2 (ADR-297 D3 phase 4). The two
 * transaction-axis values (PartialRetry / AtomicRollback) were mis-merged into
 * this dependency axis and map to the closest dependency behavior.
 */
export const LEGACY_DEGRADATION_BEHAVIORS: Readonly<Record<string, ExternalDependencyBehavior>> =
  Object.freeze({
    FailFast: "FAIL",
    SilentDegrade: "FALLBACK",
    Retry: "CACHE",
    PartialRetry: "CACHE",
    AtomicRollback: "FAIL",
  });

/**
 * Spec §45 `FailureSemantics` — the transaction (eventual-failure) axis,
 * orthogonal to `degradationBehavior`. Mirrors the Rust IR
 * `EventualFailureSemantics`; enforced on the IR side (no TS phenotype field
 * consumes it yet) and declared here for cross-language parity.
 */
export type EventualFailureSemantics =
  | "ATOMIC_ROLLBACK"
  | "PARTIAL_RETRY"
  | "SILENT_DEGRADE"
  | "FAIL_FAST";

/**
 * Dry-run protocol declaration (ADR-220 T1, "Tesla mind simulation" pattern).
 *
 * Spec §4.2 v2.11; v0.9 plan §3.11.
 */
export interface SimulationSpec {
  supportsDryRun: boolean;
  /** Inline expression that generates representative test input. */
  syntheticInputGenerator?: string;
  /** Inline expression that validates dry-run output. */
  expectedOutputValidator?: string;
  resourceEstimate: {
    estimatedLatencyMs: number;
    /** SHOULD for LLM-Native genes. */
    estimatedTokens?: number;
  };
}

/**
 * Graceful degradation declaration (ADR-220 E2, "Euler post-blindness").
 *
 * Spec §4.2 v2.11; v0.9 plan §3.11.
 */
export interface DegradationSpec {
  mode: "FAIL_FAST" | "PARTIAL_OUTPUT" | "FALLBACK_LOGIC";
  /** SHOULD for PARTIAL_OUTPUT mode — schema of degraded output. */
  fallbackOutputSchema?: unknown;
  /** Set of `externalDependencies[].semanticTag` values whose absence is tolerable. */
  minimumDependencies: string[];
}

export const DEGRADATION_MODES: readonly DegradationSpec["mode"][] = [
  "FAIL_FAST",
  "PARTIAL_OUTPUT",
  "FALLBACK_LOGIC",
] as const;

// ─── LLM template + guard config (used by prompt.* / guard.* domain Genes) ───

export type TemplateFormat = "mustache" | "handlebars" | "jinja2" | "fstring" | "raw";

export const TEMPLATE_FORMATS: readonly TemplateFormat[] = [
  "mustache",
  "handlebars",
  "jinja2",
  "fstring",
  "raw",
] as const;

export type GuardPosition = "input" | "output" | "both";

export const GUARD_POSITIONS: readonly GuardPosition[] = ["input", "output", "both"] as const;

export interface LlmRequirements {
  templateFormat?: TemplateFormat;
  templateVariables?: string[];
}

export interface GuardConfig {
  position?: GuardPosition;
  categories?: string[];
  riskThreshold?: number;
}

// ─── Phenotype shape ─────────────────────────────────────────────────────────

/**
 * Phenotype is the metadata + behavioral declaration block of a Gene.
 *
 * v0.9.1 §3.3 adds `executionModel` (and forward-compat optional `systemPrompt`
 * for CHAT mode) per ADR-253 D4.4 + ADR-256 D4.
 *
 * All fields are optional at the type level — runtime validation enforces
 * which combinations are required (see `phenotype-validator.ts`).
 */
export interface Phenotype {
  // Identity + classification
  name?: string;
  domain?: string;
  version?: string;
  fidelity?: Fidelity;
  description?: string;
  synthesisMethod?: SynthesisMethod;

  // I/O schemas (JSON Schema documents)
  inputSchema?: unknown;
  outputSchema?: unknown;

  // v0.9.1 §3.3 — execution mode declaration
  executionModel?: ExecutionModel;
  /**
   * Optional system prompt for CHAT mode. Consumed by the rotifer.ai chat
   * surface as the Agent's initial system message. Ignored for non-CHAT
   * executionModel (validator emits W0101 if set).
   */
  systemPrompt?: string;

  // Domain-conditional config
  llmRequirements?: LlmRequirements;
  guardConfig?: GuardConfig;

  // v0.9 §3.11 Hybrid Fidelity (spec §4.2 v2.11, ADR-220 D-04).
  // Hybrid genes that perform external API calls SHOULD declare both
  // `externalDependencies` (semantic layer) and `network` (protocol layer,
  // currently typed via JSON Schema documents — full NetworkConfig type
  // lives in spec §4.2; runtime validator only structurally checks shape).
  externalDependencies?: ExternalDependency[];
  simulationSpec?: SimulationSpec;
  degradationSpec?: DegradationSpec;

  // Forward-compat: unknown fields are preserved by publish.ts when stored in
  // Supabase as JSONB.
  [key: string]: unknown;
}
