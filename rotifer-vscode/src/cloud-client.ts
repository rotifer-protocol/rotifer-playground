import * as vscode from "vscode";

export interface CloudGene {
  id: string;
  name: string;
  owner: string;
  domain: string;
  version: string;
  fidelity: string;
  description: string;
  phenotype: Record<string, unknown>;
  wasm_path: string | null;
  wasm_size: number;
  downloads: number;
  reputation_score: number | null;
  created_at: string;
}

export interface GeneReputation {
  score: number;
  arenaScore: number;
  usageScore: number;
  stabilityScore: number;
  epoch: number;
  computedAt: string;
}

export interface GeneStats {
  total: number;
  last_7d: number;
  last_30d: number;
  last_90d: number;
}

export interface GeneVersionEntry {
  id: string;
  version: string;
  changelog: string | null;
  previous_version_id: string | null;
  created_at: string;
}

export interface ArenaEntry {
  rank: number;
  gene_id: string;
  gene_name: string;
  owner: string;
  domain: string;
  fidelity: string;
  fitness: number;
  safety: number;
  reputation_score: number | null;
}

export interface LeaderboardEntry {
  username: string;
  avatar_url: string | null;
  score: number;
  genes_published: number;
  total_downloads: number;
  arena_wins: number;
}

export interface DeveloperReputation {
  score: number;
  genes_published: number;
  total_downloads: number;
  arena_wins: number;
  community_bonus: number;
}

export function deduplicateLatestVersion(genes: CloudGene[]): CloudGene[] {
  const map = new Map<string, CloudGene>();
  for (const g of genes) {
    const key = `${g.owner}\0${g.name}`;
    const existing = map.get(key);
    if (!existing || new Date(g.created_at) > new Date(existing.created_at)) {
      map.set(key, g);
    }
  }
  return [...map.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export class RotiferCloudClient {
  private accessToken: string | null = null;

  get endpoint(): string {
    return vscode.workspace.getConfiguration("rotifer").get<string>("cloudEndpoint")
      || "https://vihbmpuqlamhxbmahcje.supabase.co";
  }

  get anonKey(): string {
    return vscode.workspace.getConfiguration("rotifer").get<string>("anonKey") || "";
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.anonKey) {
      h["apikey"] = this.anonKey;
    }
    h["Authorization"] = `Bearer ${this.accessToken || this.anonKey}`;
    return h;
  }

  private apiUrl(path: string): string {
    return `${this.endpoint}/rest/v1${path}`;
  }

  private rpcUrl(name: string): string {
    return `${this.endpoint}/rest/v1/rpc/${name}`;
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  // ── Gene Registry ──

  async listGenes(options?: { domain?: string; query?: string }): Promise<CloudGene[]> {
    const params = new URLSearchParams();
    params.set("published", "eq.true");
    params.set("select", "id,name,domain,version,fidelity,description,phenotype,wasm_path,wasm_size,downloads,reputation_score,created_at,profiles(username)");
    params.set("order", "created_at.desc");
    params.set("limit", "200");

    if (options?.domain) params.set("domain", `eq.${options.domain}`);
    if (options?.query) params.set("or", `(name.ilike.*${options.query}*,description.ilike.*${options.query}*)`);

    const res = await fetch(this.apiUrl(`/genes?${params}`), { headers: this.headers() });
    if (!res.ok) throw new Error(`Cloud API error (${res.status})`);

    const data = await res.json() as any[];
    const allGenes = data.map((row) => ({
      id: row.id,
      name: row.name,
      owner: row.profiles?.username || "unknown",
      domain: row.domain,
      version: row.version,
      fidelity: row.fidelity,
      description: row.description || "",
      phenotype: row.phenotype || {},
      wasm_path: row.wasm_path || null,
      wasm_size: row.wasm_size || 0,
      downloads: row.downloads || 0,
      reputation_score: row.reputation_score ?? null,
      created_at: row.created_at,
    }));
    return deduplicateLatestVersion(allGenes);
  }

  async downloadWasm(wasmPath: string): Promise<Buffer> {
    const url = `${this.endpoint}/storage/v1/object/public/gene-wasm/${wasmPath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download WASM (${res.status})`);
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }

  // ── Gene Detail & Reputation ──

  async getGeneReputation(geneId: string): Promise<GeneReputation | null> {
    const params = new URLSearchParams();
    params.set("gene_id", `eq.${geneId}`);
    params.set("select", "score,arena_score,usage_score,stability_score,epoch,computed_at");
    params.set("order", "computed_at.desc");
    params.set("limit", "1");

    const res = await fetch(this.apiUrl(`/gene_reputation?${params}`), { headers: this.headers() });
    if (!res.ok) return null;

    const data = await res.json() as any[];
    if (data.length === 0) return null;

    const row = data[0];
    return {
      score: row.score,
      arenaScore: row.arena_score,
      usageScore: row.usage_score,
      stabilityScore: row.stability_score,
      epoch: row.epoch,
      computedAt: row.computed_at,
    };
  }

  async getGeneStats(geneId: string): Promise<GeneStats> {
    const res = await fetch(this.rpcUrl("get_gene_stats"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ p_gene_id: geneId }),
    });
    if (!res.ok) throw new Error(`Stats API error (${res.status})`);
    const data = await res.json() as any;
    return {
      total: data.total ?? 0,
      last_7d: data.last_7d ?? 0,
      last_30d: data.last_30d ?? 0,
      last_90d: data.last_90d ?? 0,
    };
  }

  async listGeneVersions(owner: string, name: string): Promise<GeneVersionEntry[]> {
    const params = new URLSearchParams();
    params.set("name", `eq.${name}`);
    params.set("published", "eq.true");
    params.set("select", "id,version,changelog,previous_version_id,created_at,profiles(username)");
    params.set("order", "created_at.asc");

    const res = await fetch(this.apiUrl(`/genes?${params}`), { headers: this.headers() });
    if (!res.ok) throw new Error(`Versions API error (${res.status})`);
    const data = await res.json() as any[];

    return data
      .filter((row) => (row.profiles?.username || "").toLowerCase() === owner.toLowerCase())
      .map((row) => ({
        id: row.id,
        version: row.version,
        changelog: row.changelog ?? null,
        previous_version_id: row.previous_version_id ?? null,
        created_at: row.created_at,
      }));
  }

  // ── Arena ──

  async getArenaRankings(options?: { domain?: string }): Promise<ArenaEntry[]> {
    const params = new URLSearchParams();
    params.set("select", "fitness_value,safety_score,domain,genes(id,name,fidelity,reputation_score,profiles(username))");
    params.set("order", "fitness_value.desc");
    params.set("limit", "50");

    if (options?.domain) params.set("domain", `eq.${options.domain}`);

    const res = await fetch(this.apiUrl(`/arena_entries?${params}`), { headers: this.headers() });
    if (!res.ok) throw new Error(`Arena API error (${res.status})`);
    const data = await res.json() as any[];

    return data.map((row, i) => ({
      rank: i + 1,
      gene_id: row.genes?.id || "",
      gene_name: row.genes?.name || "unknown",
      owner: row.genes?.profiles?.username || "unknown",
      domain: row.domain,
      fidelity: row.genes?.fidelity || "Wrapped",
      fitness: row.fitness_value,
      safety: row.safety_score,
      reputation_score: row.genes?.reputation_score ?? null,
    }));
  }

  // ── Leaderboard & Developer ──

  async getLeaderboard(limit: number = 20): Promise<LeaderboardEntry[]> {
    const res = await fetch(this.rpcUrl("get_reputation_leaderboard"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ p_limit: limit }),
    });
    if (!res.ok) throw new Error(`Leaderboard API error (${res.status})`);
    const data = await res.json() as any[];
    return data.map((row) => ({
      username: row.username,
      avatar_url: row.avatar_url,
      score: row.score,
      genes_published: row.genes_published,
      total_downloads: Number(row.total_downloads),
      arena_wins: row.arena_wins,
    }));
  }

  async getMyReputation(): Promise<DeveloperReputation | null> {
    if (!this.accessToken) return null;

    const userRes = await fetch(`${this.endpoint}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, apikey: this.anonKey },
    });
    if (!userRes.ok) return null;
    const userData = await userRes.json() as any;

    const params = new URLSearchParams();
    params.set("user_id", `eq.${userData.id}`);
    const res = await fetch(this.apiUrl(`/developer_reputation?${params}`), { headers: this.headers() });
    if (!res.ok) return null;
    const data = await res.json() as any[];

    if (data.length === 0) {
      return { score: 0, genes_published: 0, total_downloads: 0, arena_wins: 0, community_bonus: 0 };
    }

    const row = data[0];
    return {
      score: row.score,
      genes_published: row.genes_published,
      total_downloads: Number(row.total_downloads),
      arena_wins: row.arena_wins,
      community_bonus: row.community_bonus ?? 0,
    };
  }

  // ── Domain Suggestion ──

  async getDomains(): Promise<string[]> {
    const params = new URLSearchParams();
    params.set("select", "domain");
    params.set("published", "eq.true");
    params.set("order", "domain");

    const res = await fetch(this.apiUrl(`/genes?${params}`), { headers: this.headers() });
    if (!res.ok) return [];
    const data = await res.json() as any[];
    return [...new Set(data.map((r: any) => r.domain as string))].sort();
  }

  // ── Auth helpers ──

  async getUserInfo(): Promise<{ id: string; username: string; avatar_url: string | null } | null> {
    if (!this.accessToken) return null;
    try {
      const res = await fetch(`${this.endpoint}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${this.accessToken}`, apikey: this.anonKey },
      });
      if (!res.ok) return null;
      const data = await res.json() as any;
      const meta = data.user_metadata || {};
      return {
        id: data.id,
        username: meta.user_name || meta.preferred_username || meta.name || meta.nickname || "unknown",
        avatar_url: meta.avatar_url || null,
      };
    } catch {
      return null;
    }
  }
}
