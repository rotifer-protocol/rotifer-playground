import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CloudConfig,
  CloudGene,
  CloudGeneListResponse,
  CloudArenaRankings,
  CloudArenaEntry,
  FitnessReport,
} from "./types.js";
import { DEFAULT_CLOUD_ENDPOINT, CLOUD_CONFIG_FILE } from "./types.js";
import { loadCredentials, refreshTokenIfNeeded } from "./auth.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);

export function loadCloudConfig(): CloudConfig {
  const configPath = join(ROTIFER_HOME, CLOUD_CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as CloudConfig;
    } catch {
      // fall through to defaults
    }
  }
  return {
    endpoint: DEFAULT_CLOUD_ENDPOINT,
    anonKey: process.env.ROTIFER_CLOUD_ANON_KEY || "",
  };
}

function apiUrl(path: string): string {
  const config = loadCloudConfig();
  const base = config.endpoint.replace(/\/+$/, "");
  return `${base}/rest/v1${path}`;
}

function storageUrl(path: string): string {
  const config = loadCloudConfig();
  const base = config.endpoint.replace(/\/+$/, "");
  return `${base}/storage/v1${path}`;
}

function authHeaders(requireToken: boolean = false): Record<string, string> {
  const config = loadCloudConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: config.anonKey,
  };

  const creds = loadCredentials();
  if (creds) {
    headers["Authorization"] = `Bearer ${creds.access_token}`;
  } else if (requireToken) {
    throw new Error("Not logged in. Run 'rotifer login' first.");
  }

  return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    let message: string;
    try {
      const parsed = JSON.parse(body);
      message = parsed.message || parsed.error?.message || body;
    } catch {
      message = body;
    }
    throw new Error(`Cloud API error (${res.status}): ${message}`);
  }
  return res.json() as Promise<T>;
}

// --- Gene Registry ---

function deduplicateLatestVersion(genes: CloudGene[]): CloudGene[] {
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

export async function listGenes(options: {
  domain?: string;
  query?: string;
  owner?: string;
  fidelity?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}): Promise<CloudGeneListResponse> {
  const params = new URLSearchParams();
  params.set("published", "eq.true");
  params.set("select", "id,name,domain,version,fidelity,description,wasm_size,downloads,reputation_score,created_at,updated_at,profiles(username)");
  params.set("order", "created_at.desc");

  if (options.domain) params.set("domain", `eq.${options.domain}`);
  if (options.fidelity) params.set("fidelity", `eq.${options.fidelity}`);
  if (options.query) params.set("or", `(name.ilike.*${options.query}*,description.ilike.*${options.query}*)`);

  const limit = options.perPage || 20;
  const fetchLimit = limit * 3;
  params.set("limit", String(fetchLimit));
  params.set("offset", "0");

  const res = await fetch(apiUrl(`/genes?${params}`), {
    headers: {
      ...authHeaders(),
      Prefer: "count=exact",
    },
  });

  const data = await handleResponse<any[]>(res);

  const allGenes: CloudGene[] = data.map((row) => ({
    id: row.id,
    name: row.name,
    owner: row.profiles?.username || "unknown",
    domain: row.domain,
    version: row.version,
    fidelity: row.fidelity,
    description: row.description,
    phenotype: {},
    wasm_url: null,
    wasm_size: row.wasm_size || 0,
    downloads: row.downloads || 0,
    fitness: null,
    reputation_score: row.reputation_score ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const deduped = deduplicateLatestVersion(allGenes);
  const page = options.page || 1;
  const offset = (page - 1) * limit;
  const paged = deduped.slice(offset, offset + limit);

  return { genes: paged, total: deduped.length, page, per_page: limit };
}

export async function getGene(id: string): Promise<CloudGene> {
  const params = new URLSearchParams();
  params.set("id", `eq.${id}`);
  params.set("select", "*, profiles(username)");

  const res = await fetch(apiUrl(`/genes?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);
  if (data.length === 0) throw new Error(`Gene '${id}' not found`);

  const row = data[0];
  const config = loadCloudConfig();
  const wasmUrl = row.wasm_path
    ? `${config.endpoint.replace(/\/+$/, "")}/storage/v1/object/public/gene-wasm/${row.wasm_path}`
    : null;

  return {
    id: row.id,
    name: row.name,
    owner: row.profiles?.username || "unknown",
    domain: row.domain,
    version: row.version,
    fidelity: row.fidelity,
    description: row.description,
    phenotype: row.phenotype || {},
    wasm_url: wasmUrl,
    wasm_size: row.wasm_size || 0,
    downloads: row.downloads || 0,
    fitness: null,
    reputation_score: row.reputation_score ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function publishGene(opts: {
  name: string;
  domain: string;
  version: string;
  fidelity: string;
  description: string;
  phenotype: Record<string, unknown>;
  wasmBytes: Buffer | null;
  readme?: string | null;
  changelog?: string | null;
}): Promise<CloudGene & { isUpdate: boolean }> {
  await refreshTokenIfNeeded();
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in. Run 'rotifer login' first.");

  let wasmPath: string | null = null;
  let wasmSize = 0;

  if (opts.wasmBytes) {
    wasmPath = `${creds.user.id}/${opts.name}/${opts.version}/gene.ir.wasm`;
    wasmSize = opts.wasmBytes.length;

    const uploadRes = await fetch(
      storageUrl(`/object/gene-wasm/${wasmPath}`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.access_token}`,
          apikey: loadCloudConfig().anonKey,
          "Content-Type": "application/wasm",
          "x-upsert": "true",
        },
        body: new Uint8Array(opts.wasmBytes),
      }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`Failed to upload WASM: ${err}`);
    }
  }

  const existCheck = await fetch(
    apiUrl(`/genes?owner_id=eq.${creds.user.id}&name=eq.${opts.name}&version=eq.${opts.version}&select=id`),
    { headers: authHeaders() }
  );
  const existData = existCheck.ok ? ((await existCheck.json()) as any[]) : [];
  const isUpdate = existData.length > 0;

  let previousVersionId: string | null = null;
  if (!isUpdate) {
    const prevCheck = await fetch(
      apiUrl(`/genes?owner_id=eq.${creds.user.id}&name=eq.${opts.name}&select=id&order=created_at.desc&limit=1`),
      { headers: authHeaders() }
    );
    const prevData = prevCheck.ok ? ((await prevCheck.json()) as any[]) : [];
    if (prevData.length > 0) {
      previousVersionId = prevData[0].id;
    }
  }

  const changelog = opts.changelog
    ? opts.changelog.slice(0, 500)
    : null;

  const body: Record<string, unknown> = {
    owner_id: creds.user.id,
    name: opts.name,
    domain: opts.domain,
    version: opts.version,
    fidelity: opts.fidelity,
    description: opts.description,
    phenotype: opts.phenotype,
    wasm_path: wasmPath,
    wasm_size: wasmSize,
    published: true,
  };
  if (opts.readme) body.readme = opts.readme;
  if (changelog) body.changelog = changelog;
  if (previousVersionId) body.previous_version_id = previousVersionId;

  const res = await fetch(apiUrl("/genes?on_conflict=owner_id,name,version"), {
    method: "POST",
    headers: {
      ...authHeaders(true),
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(body),
  });

  const data = await handleResponse<any[]>(res);
  const row = data[0];

  return {
    id: row.id,
    name: row.name,
    owner: creds.user.username,
    domain: row.domain,
    version: row.version,
    fidelity: row.fidelity,
    description: row.description,
    phenotype: row.phenotype,
    wasm_url: wasmPath
      ? `${loadCloudConfig().endpoint}/storage/v1/object/public/gene-wasm/${wasmPath}`
      : null,
    wasm_size: row.wasm_size,
    downloads: 0,
    fitness: null,
    reputation_score: row.reputation_score ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    isUpdate,
  };
}

export async function unpublishGene(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/genes?id=eq.${id}`), {
    method: "PATCH",
    headers: {
      ...authHeaders(true),
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ published: false }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to unpublish gene: ${err}`);
  }
}

export async function downloadGeneWasm(wasmUrl: string): Promise<Buffer> {
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`Failed to download WASM (${res.status})`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function trackDownload(geneId: string): Promise<void> {
  await fetch(apiUrl("/rpc/track_download"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ p_gene_id: geneId }),
  }).catch(() => {});
}

// --- Cloud Arena ---

export async function arenaSubmit(
  geneId: string,
  fitness: FitnessReport
): Promise<CloudArenaEntry> {
  const gene = await getGene(geneId);

  const body = {
    gene_id: geneId,
    domain: gene.domain,
    fitness_value: fitness.value,
    safety_score: fitness.safety_score,
    success_rate: fitness.success_rate,
    latency_score: fitness.latency_score,
    resource_efficiency: fitness.resource_efficiency,
    total_calls: 1,
  };

  const res = await fetch(apiUrl("/arena_entries"), {
    method: "POST",
    headers: {
      ...authHeaders(true),
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(body),
  });

  const data = await handleResponse<any[]>(res);
  const row = data[0];

  return {
    rank: 0,
    gene_id: row.gene_id,
    gene_name: gene.name,
    owner: gene.owner,
    domain: row.domain,
    fidelity: gene.fidelity,
    fitness: row.fitness_value,
    safety: row.safety_score,
    success_rate: row.success_rate ?? 0,
    latency_score: row.latency_score ?? 0,
    resource_efficiency: row.resource_efficiency ?? 0,
    reputation_score: (gene as any).reputation_score ?? null,
    total_calls: row.total_calls,
    last_evaluated: row.last_evaluated,
  };
}

export async function arenaRankings(options: {
  domain?: string;
  page?: number;
  perPage?: number;
}): Promise<CloudArenaRankings> {
  const params = new URLSearchParams();
  params.set(
    "select",
    "fitness_value,safety_score,success_rate,latency_score,resource_efficiency,total_calls,last_evaluated,domain,genes(id,name,fidelity,reputation_score,profiles(username))"
  );
  params.set("order", "fitness_value.desc");

  if (options.domain) params.set("domain", `eq.${options.domain}`);

  const limit = options.perPage || 50;
  const offset = ((options.page || 1) - 1) * limit;
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const res = await fetch(apiUrl(`/arena_entries?${params}`), {
    headers: {
      ...authHeaders(),
      Prefer: "count=exact",
    },
  });

  const total = parseInt(
    res.headers.get("content-range")?.split("/")[1] || "0",
    10
  );
  const data = await handleResponse<any[]>(res);

  const rankings: CloudArenaEntry[] = data.map((row, i) => ({
    rank: offset + i + 1,
    gene_id: row.genes?.id || "",
    gene_name: row.genes?.name || "unknown",
    owner: row.genes?.profiles?.username || "unknown",
    domain: row.domain,
    fidelity: row.genes?.fidelity || "Wrapped",
    fitness: row.fitness_value,
    safety: row.safety_score,
    success_rate: row.success_rate,
    latency_score: row.latency_score,
    resource_efficiency: row.resource_efficiency,
    reputation_score: row.genes?.reputation_score ?? null,
    total_calls: row.total_calls || 0,
    last_evaluated: row.last_evaluated,
  }));

  return { rankings, total, domain: options.domain || null };
}

// --- Reputation ---

export interface GeneReputationResponse {
  gene_name: string;
  score: number;
  arena_score: number;
  usage_score: number;
  stability_score: number;
  epoch: number;
  computed_at: string;
}

export interface DeveloperReputationResponse {
  score: number;
  genes_published: number;
  total_downloads: number;
  arena_wins: number;
  community_bonus: number;
}

export interface LeaderboardEntry {
  username: string;
  avatar_url: string | null;
  score: number;
  genes_published: number;
  total_downloads: number;
  arena_wins: number;
}

export async function getGeneReputation(geneId: string): Promise<GeneReputationResponse> {
  const params = new URLSearchParams();
  params.set("gene_id", `eq.${geneId}`);
  params.set("select", "score,arena_score,usage_score,stability_score,epoch,computed_at,genes(name)");
  params.set("order", "computed_at.desc");
  params.set("limit", "1");

  const res = await fetch(apiUrl(`/gene_reputation?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);

  if (data.length === 0) {
    // No reputation computed yet — compute on the fly via RPC
    const rpcRes = await fetch(apiUrl("/rpc/compute_gene_reputation"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ p_gene_id: geneId }),
    });
    const score = await handleResponse<number>(rpcRes);

    return {
      gene_name: geneId,
      score,
      arena_score: 0,
      usage_score: 0,
      stability_score: 0,
      epoch: 1,
      computed_at: new Date().toISOString(),
    };
  }

  const row = data[0];
  return {
    gene_name: row.genes?.name || geneId,
    score: row.score,
    arena_score: row.arena_score,
    usage_score: row.usage_score,
    stability_score: row.stability_score,
    epoch: row.epoch,
    computed_at: row.computed_at,
  };
}

export async function getDeveloperReputation(userId: string): Promise<DeveloperReputationResponse> {
  const params = new URLSearchParams();
  params.set("user_id", `eq.${userId}`);

  const res = await fetch(apiUrl(`/developer_reputation?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);

  if (data.length === 0) {
    const rpcRes = await fetch(apiUrl("/rpc/compute_developer_reputation"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ p_user_id: userId }),
    });
    const score = await handleResponse<number>(rpcRes);

    return {
      score,
      genes_published: 0,
      total_downloads: 0,
      arena_wins: 0,
      community_bonus: 0,
    };
  }

  const row = data[0];
  return {
    score: row.score,
    genes_published: row.genes_published,
    total_downloads: row.total_downloads,
    arena_wins: row.arena_wins,
    community_bonus: row.community_bonus,
  };
}

// --- Gene Version History ---

export interface GeneVersionEntry {
  id: string;
  version: string;
  changelog: string | null;
  previous_version_id: string | null;
  created_at: string;
}

export async function listGeneVersions(owner: string, name: string): Promise<GeneVersionEntry[]> {
  const params = new URLSearchParams();
  params.set("name", `eq.${name}`);
  params.set("published", "eq.true");
  params.set("select", "id,version,changelog,previous_version_id,created_at,profiles(username)");
  params.set("order", "created_at.asc");

  const res = await fetch(apiUrl(`/genes?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);

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

// --- Gene Download Stats ---

export interface GeneStatsResponse {
  total: number;
  last_7d: number;
  last_30d: number;
  last_90d: number;
}

export async function getGeneStats(geneId: string): Promise<GeneStatsResponse> {
  const res = await fetch(apiUrl("/rpc/get_gene_stats"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ p_gene_id: geneId }),
  });
  const data = await handleResponse<GeneStatsResponse & { error?: string }>(res);
  if (data.error) throw new Error(data.error);
  return {
    total: data.total ?? 0,
    last_7d: data.last_7d ?? 0,
    last_30d: data.last_30d ?? 0,
    last_90d: data.last_90d ?? 0,
  };
}

export async function getReputationLeaderboard(limit: number = 20): Promise<LeaderboardEntry[]> {
  const res = await fetch(apiUrl("/rpc/get_reputation_leaderboard"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ p_limit: limit }),
  });
  const data = await handleResponse<any[]>(res);

  return data.map((row) => ({
    username: row.username,
    avatar_url: row.avatar_url,
    score: row.score,
    genes_published: row.genes_published,
    total_downloads: row.total_downloads,
    arena_wins: row.arena_wins,
  }));
}
