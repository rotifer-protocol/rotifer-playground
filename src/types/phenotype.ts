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

  // Forward-compat: unknown fields are preserved by publish.ts when stored in
  // Supabase as JSONB.
  [key: string]: unknown;
}
