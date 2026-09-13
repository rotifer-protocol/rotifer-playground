export interface CloudConfig {
  endpoint: string;
  anonKey: string;
}

export type AuthProvider = "github" | "gitlab" | "email";

export type SynthesisMethod = "MANUAL" | "LLM_ASSISTED" | "LLM_AUTO" | "MUTATION" | "DE_NOVO";
export const VALID_SYNTHESIS_METHODS: SynthesisMethod[] = ["MANUAL", "LLM_ASSISTED", "LLM_AUTO", "MUTATION", "DE_NOVO"];

export interface CloudCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  provider: AuthProvider;
  user: CloudUser;
}

export interface CloudUser {
  id: string;
  username: string;
  avatar_url: string | null;
  provider_id: string;
}

export interface CloudGene {
  id: string;
  name: string;
  owner: string;
  domain: string;
  version: string;
  fidelity: string;
  description: string | null;
  phenotype: Record<string, unknown>;
  wasm_url: string | null;
  wasm_size: number;
  wasm_hash: string | null;
  content_hash: string | null;
  downloads: number;
  fitness: number | null;
  reputation_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface CloudGeneListResponse {
  genes: CloudGene[];
  total: number;
  page: number;
  per_page: number;
  total_exact?: boolean;
}

export interface CloudArenaEntry {
  rank: number;
  gene_id: string;
  gene_name: string;
  owner: string;
  domain: string;
  fidelity: string;
  fitness: number;
  safety: number;
  success_rate: number;
  latency_score: number;
  resource_efficiency: number;
  reputation_score: number | null;
  total_calls: number;
  last_evaluated: string;
}

export interface FitnessReport {
  value: number;
  /**
   * §5.1 / §33.1 dual-column: the raw base and the FIDELITY_DISCOUNT entry that
   * was applied, so `value = base_fitness × fidelity_discount` is reconstructible
   * from the row after the protocol parameter moves. Optional for the same
   * reason `evaluation_method` is — a client that omits them leaves the ledger
   * columns NULL, which reads as "not recorded", never as "discount 1.0".
   */
  base_fitness?: number;
  fidelity_discount?: number;
  safety_score: number;
  success_rate: number;
  latency_score: number;
  resource_efficiency: number;
  /**
   * How these numbers were obtained (ADR-319 D2). The CLI already knew this —
   * it wrote it into .arena-cache.json — and then dropped it at the network
   * boundary, so every score reached the Arena indistinguishable from every
   * other. Omitted means the server records 'unknown-legacy', which does not
   * rank: saying nothing costs the rank rather than granting one.
   *
   * `binding_runtime` is not listed: it is attested by the server from the
   * authenticated principal and refused from clients.
   */
  evaluation_method?: "sandbox" | "estimated" | "declared";
  /** Runs behind the numbers (ADR-318 D5). Omitted means unknown, not 1. */
  evaluation_n?: number;
}

export interface CloudError {
  error: {
    code: string;
    message: string;
    status: number;
  };
}

export interface ContributionMetrics {
  gene_id: string;
  total_invocations: number;
  unique_callers: number;
  invocations_last_30d: number;
  derivation_count: number;
  composition_count: number;
  downstream_success_rate: number;
  updated_at: string;
}

export const DEFAULT_CLOUD_ENDPOINT =
  process.env.ROTIFER_CLOUD_ENDPOINT || "https://cloud.rotifer.dev";

/**
 * Built-in key for the public Rotifer Cloud.
 *
 * This is a *publishable* key and is public by design: it ships in the
 * rotifer.ai page source too, and access is enforced by Row Level Security,
 * not by the key being secret. Shipping it means `rotifer search` works on a
 * fresh install with nothing configured — which is what users expect, and what
 * did not happen before: the CLI defaulted to an empty key and every cloud
 * command failed with "No API key found in request".
 *
 * Self-hosted or regional deployments override it via `~/.rotifer/cloud.json`
 * or ROTIFER_CLOUD_ANON_KEY, as documented in the cloud guide.
 */
export const DEFAULT_CLOUD_ANON_KEY = "sb_publishable_6aCznk-jn2QIQcN3QZobKg_3r9C-wzk";

/**
 * True for a legacy JWT-based anon/service_role key.
 *
 * Rotifer Cloud disabled those on 2026-09-07, so one left behind in a config
 * file is not a preference to honour — it is a stale value that would make a
 * working CLI report an authentication error. Detecting the shape lets us fall
 * through to something that works instead.
 */
export function isLegacyJwtKey(key: string | undefined): boolean {
  return typeof key === "string" && key.startsWith("eyJ");
}

/**
 * Pick the key to send: an explicitly configured one wins, the built-in
 * default covers everyone else, and stale legacy keys are skipped at every
 * level rather than passed on to fail at the server.
 */
export function resolveAnonKey(
  fromConfigFile: string | undefined,
  fromEnv: string | undefined,
): string {
  for (const candidate of [fromConfigFile, fromEnv]) {
    if (candidate && !isLegacyJwtKey(candidate)) return candidate;
  }
  return DEFAULT_CLOUD_ANON_KEY;
}
export const CREDENTIALS_FILE = "credentials.json";
export const CLOUD_CONFIG_FILE = "cloud.json";
