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

export interface CloudArenaRankings {
  rankings: CloudArenaEntry[];
  total: number;
  domain: string | null;
}

export interface FitnessReport {
  value: number;
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
export const CREDENTIALS_FILE = "credentials.json";
export const CLOUD_CONFIG_FILE = "cloud.json";
