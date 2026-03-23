export interface CloudConfig {
  endpoint: string;
  anonKey: string;
}

export type AuthProvider = "github" | "gitlab" | "email";

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
