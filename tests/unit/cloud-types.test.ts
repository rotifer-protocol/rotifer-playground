import { describe, it, expect } from "vitest";
import {
  DEFAULT_CLOUD_ENDPOINT,
  CREDENTIALS_FILE,
  CLOUD_CONFIG_FILE,
} from "../../src/cloud/types.js";
import type {
  CloudConfig,
  CloudCredentials,
  CloudGene,
  CloudArenaEntry,
  FitnessReport,
  CloudGeneListResponse,
  CloudArenaRankings,
} from "../../src/cloud/types.js";

describe("cloud types", () => {
  it("exports correct default constants", () => {
    expect(DEFAULT_CLOUD_ENDPOINT).toContain("rotifer");
    expect(CREDENTIALS_FILE).toBe("credentials.json");
    expect(CLOUD_CONFIG_FILE).toBe("cloud.json");
  });

  it("CloudConfig interface is structurally valid", () => {
    const config: CloudConfig = {
      endpoint: "https://example.supabase.co",
      anonKey: "test-key",
    };
    expect(config.endpoint).toBeDefined();
    expect(config.anonKey).toBeDefined();
  });

  it("CloudCredentials interface is structurally valid", () => {
    const creds: CloudCredentials = {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Date.now() + 3600_000,
      user: {
        id: "uuid",
        username: "dev",
        avatar_url: "https://avatar.example.com/dev.png",
        github_id: 12345,
      },
    };
    expect(creds.user.username).toBe("dev");
  });

  it("CloudGene interface is structurally valid", () => {
    const gene: CloudGene = {
      id: "gene-uuid",
      name: "test-gene",
      owner: "testdev",
      domain: "search.web",
      version: "1.0.0",
      fidelity: "Native",
      description: "A test gene",
      phenotype: { domain: "search.web" },
      wasm_url: "https://storage.example.com/test.wasm",
      wasm_size: 1024,
      downloads: 42,
      fitness: 0.87,
      reputation_score: 0.72,
      created_at: "2026-02-17T00:00:00Z",
      updated_at: "2026-02-17T00:00:00Z",
    };
    expect(gene.fidelity).toBe("Native");
    expect(gene.downloads).toBe(42);
  });

  it("FitnessReport interface is structurally valid", () => {
    const report: FitnessReport = {
      value: 0.87,
      safety_score: 0.95,
      success_rate: 0.98,
      latency_score: 0.82,
      resource_efficiency: 0.76,
    };
    expect(report.value).toBeGreaterThan(0);
    expect(report.safety_score).toBeLessThanOrEqual(1);
  });

  it("CloudArenaEntry interface is structurally valid", () => {
    const entry: CloudArenaEntry = {
      rank: 1,
      gene_id: "uuid",
      gene_name: "top-gene",
      owner: "dev",
      domain: "search.web",
      fidelity: "Native",
      fitness: 0.95,
      safety: 0.99,
      reputation_score: 0.88,
      total_calls: 1000,
      last_evaluated: "2026-02-17T00:00:00Z",
    };
    expect(entry.rank).toBe(1);
  });

  it("CloudGeneListResponse paginates correctly", () => {
    const response: CloudGeneListResponse = {
      genes: [],
      total: 100,
      page: 2,
      per_page: 20,
    };
    expect(response.total).toBe(100);
    expect(response.page).toBe(2);
  });

  it("CloudArenaRankings supports null domain for global rankings", () => {
    const rankings: CloudArenaRankings = {
      rankings: [],
      total: 0,
      domain: null,
    };
    expect(rankings.domain).toBeNull();
  });
});
