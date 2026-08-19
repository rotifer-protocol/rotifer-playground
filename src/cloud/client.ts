import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  CloudConfig,
  CloudGene,
  CloudGeneListResponse,
  CloudArenaRankings,
  CloudArenaEntry,
  FitnessReport,
  ContributionMetrics,
} from "./types.js";
import { DEFAULT_CLOUD_ENDPOINT, CLOUD_CONFIG_FILE } from "./types.js";
import { loadCredentials, refreshTokenIfNeeded } from "./auth.js";
import { parseGeneRef } from "./gene-ref.js";

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

function authHeaders(isTokenRequired: boolean = false): Record<string, string> {
  const config = loadCloudConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: config.anonKey,
  };

  const creds = loadCredentials();
  if (creds) {
    headers["Authorization"] = `Bearer ${creds.access_token}`;
  } else if (isTokenRequired) {
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

interface SearchGeneRow {
  id: string;
  name: string;
  domain: string;
  version: string;
  fidelity: string;
  description: string | null;
  wasm_size: number | null;
  wasm_hash?: string | null;
  content_hash?: string | null;
  downloads: number | null;
  reputation_score: number | null;
  created_at: string;
  updated_at: string;
  owner_username: string | null;
  total_count?: number | string | null;
}

function normalizeSearchSort(sort?: string): "newest" | "relevance" | "downloads" | "reputation" {
  const requested = (sort || "newest").toLowerCase();
  switch (requested) {
    case "newest":
    case "relevance":
    case "downloads":
    case "reputation":
      return requested;
    case "popular":
      return "downloads";
    case "fitness":
      throw new Error(
        "Cloud search cannot sort by F(g). Use '--sort reputation' or 'rotifer arena list --cloud' for fitness-based rankings."
      );
    default:
      throw new Error(
        `Unsupported sort order '${sort}'. Use one of: newest, relevance, popular, downloads, reputation.`
      );
  }
}

function mapSearchGene(row: SearchGeneRow): CloudGene {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner_username || "unknown",
    domain: row.domain,
    version: row.version,
    fidelity: row.fidelity,
    description: row.description,
    phenotype: {},
    wasm_url: null,
    wasm_size: row.wasm_size || 0,
    wasm_hash: row.wasm_hash ?? null,
    content_hash: row.content_hash ?? null,
    downloads: row.downloads || 0,
    fitness: null,
    reputation_score: row.reputation_score ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseExactSearchTotal(rows: SearchGeneRow[]): number | null {
  const raw = rows[0]?.total_count;
  if (raw == null) return null;
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function fetchSearchGenes(body: {
  p_query: string | null;
  p_domain: string | null;
  p_fidelity: string | null;
  p_sort: "newest" | "relevance" | "downloads" | "reputation";
  p_limit: number;
  p_offset: number;
}): Promise<SearchGeneRow[]> {
  const res = await fetch(apiUrl("/rpc/search_genes"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return handleResponse<SearchGeneRow[]>(res);
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
  const limit =
    Number.isFinite(options.perPage) && (options.perPage as number) > 0
      ? Math.min(Math.floor(options.perPage as number), 100)
      : 20;
  const page =
    Number.isFinite(options.page) && (options.page as number) > 0
      ? Math.floor(options.page as number)
      : 1;
  const offset = (page - 1) * limit;
  const sort = normalizeSearchSort(options.sort);
  const query = options.query?.trim() || null;

  const requestBody = {
    p_query: query,
    p_domain: options.domain || null,
    p_fidelity: options.fidelity || null,
    p_sort: sort,
    p_limit: limit,
    p_offset: offset,
  };

  const rows = await fetchSearchGenes(requestBody);
  const genes = rows.map(mapSearchGene);

  let total = parseExactSearchTotal(rows);
  let isTotalExact = total != null;

  if (!isTotalExact) {
    if (rows.length === 0 && page === 1) {
      total = 0;
      isTotalExact = true;
    } else if (rows.length < limit) {
      total = offset + rows.length;
      isTotalExact = true;
    } else {
      const countRows = await fetchSearchGenes({ ...requestBody, p_limit: 1, p_offset: 0 });
      total = parseExactSearchTotal(countRows);
      isTotalExact = total != null;
    }
  }

  return {
    genes,
    total: total ?? offset + rows.length,
    page,
    per_page: limit,
    total_exact: isTotalExact,
  };
}

export async function getGene(idOrName: string): Promise<CloudGene> {
  const ref = parseGeneRef(idOrName);
  const params = new URLSearchParams();

  switch (ref.kind) {
    case "uuid":
      params.set("id", `eq.${ref.raw}`);
      params.set("select", "*, profiles(username)");
      break;
    case "contentHash":
      params.set("content_hash", `eq.${ref.raw}`);
      params.set("select", "*, profiles(username)");
      break;
    case "ownerName":
      // PostgREST embedded-resource filter requires `!inner` so the
      // server applies the profiles.username constraint as a JOIN filter
      // rather than dropping it silently. See:
      //   https://postgrest.org/en/stable/references/api/resource_embedding.html#hint-disambiguation
      params.set("name", `eq.${ref.name}`);
      params.set("profiles.username", `eq.${ref.owner}`);
      params.set("select", "*, profiles!inner(username)");
      params.set("order", "created_at.desc");
      params.set("limit", "1");
      break;
    case "name":
      params.set("name", `eq.${ref.raw}`);
      params.set("select", "*, profiles(username)");
      params.set("order", "created_at.desc");
      params.set("limit", "1");
      break;
  }

  const res = await fetch(apiUrl(`/genes?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);
  if (data.length === 0) throw new Error(`Gene '${idOrName}' not found`);

  const row = data[0];
  const config = loadCloudConfig();
  const wasmUrl = row.wasm_path ? geneWasmUrl(row.wasm_path) : null;

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
    wasm_hash: row.wasm_hash ?? null,
    content_hash: row.content_hash ?? null,
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
  contentHash: string;
  readme?: string | null;
  changelog?: string | null;
}): Promise<CloudGene & { isUpdate: boolean }> {
  await refreshTokenIfNeeded();
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in. Run 'rotifer login' first.");

  const existCheck = await fetch(
    apiUrl(
      `/genes?owner_id=eq.${creds.user.id}&name=eq.${opts.name}&version=eq.${opts.version}&select=id,published`,
    ),
    { headers: authHeaders() },
  );
  const existData = existCheck.ok ? ((await existCheck.json()) as any[]) : [];
  const isUpdate = existData.length > 0;

  if (isUpdate && existData[0].published) {
    throw new Error(
      `Version ${opts.version} of '${opts.name}' is already published and immutable. ` +
      `Bump the version number in phenotype.json to publish a new version.`,
    );
  }

  let wasmPath: string | null = null;
  let wasmSize = 0;
  let wasmHash: string | null = null;

  if (opts.wasmBytes) {
    wasmPath = `${creds.user.id}/${opts.name}/${opts.version}/gene.ir.wasm`;
    wasmSize = opts.wasmBytes.length;
    wasmHash = createHash("sha256").update(opts.wasmBytes).digest("hex");

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
    wasm_hash: wasmHash,
    content_hash: opts.contentHash,
    published: true,
  };
  if (opts.readme) body.readme = opts.readme;
  if (changelog) body.changelog = changelog;
  if (previousVersionId) body.previous_version_id = previousVersionId;

  const res = await fetch(apiUrl("/genes"), {
    method: "POST",
    headers: {
      ...authHeaders(true),
      Prefer: "return=representation",
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
    wasm_url: wasmPath ? geneWasmUrl(wasmPath) : null,
    wasm_size: row.wasm_size,
    wasm_hash: row.wasm_hash ?? null,
    content_hash: row.content_hash ?? null,
    downloads: 0,
    fitness: null,
    reputation_score: row.reputation_score ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    isUpdate,
  };
}

/** Public URL of a gene's WASM in the `gene-wasm` bucket — no credentials needed. */
export function geneWasmUrl(wasmPath: string): string {
  return `${storageUrl("/object/public/gene-wasm")}/${wasmPath}`;
}

/** One Arena row with the gene fields the invalidation criteria read. */
export interface ArenaAuditRow {
  gene_id: string;
  domain: string | null;
  fitness_value: number | null;
  evaluation_method: string | null;
  invalidated_at: string | null;
  invalidation_reason: string | null;
  genes: {
    name: string;
    version: string;
    fidelity: string;
    wasm_path: string | null;
    wasm_size: number | null;
  } | null;
}

/**
 * Every Arena row, with its gene, for a criteria audit.
 *
 * Paginated to completion rather than capped: an audit that silently stopped at
 * the first page would report a clean tail it never looked at, which is the
 * failure mode this whole audit exists to catch.
 *
 * `genes` comes back null for unpublished genes — RLS hides them from anonymous
 * callers. That is not an orphaned row: the foreign key cascades on delete.
 */
export async function fetchArenaAuditRows(): Promise<ArenaAuditRow[]> {
  const perPage = 200;
  const rows: ArenaAuditRow[] = [];
  for (let offset = 0; ; offset += perPage) {
    const params = new URLSearchParams();
    params.set(
      "select",
      "gene_id,domain,fitness_value,evaluation_method,invalidated_at,invalidation_reason,genes(name,version,fidelity,wasm_path,wasm_size)"
    );
    params.set("order", "gene_id.asc");
    params.set("limit", String(perPage));
    params.set("offset", String(offset));

    const res = await fetch(apiUrl(`/arena_entries?${params}`), { headers: authHeaders() });
    const page = await handleResponse<ArenaAuditRow[]>(res);
    rows.push(...page);
    if (page.length < perPage) return rows;
  }
}

/** The version that was taken down, echoed back from the row the server actually changed. */
export interface UnpublishedGene {
  id: string;
  name: string;
  version: string;
}

/**
 * Take one published version off the public registry.
 *
 * The row is kept and only `published` flips, so nothing that referenced this
 * version — Arena entries, invocation history, another author's dependency —
 * loses its referent. Republishing the same version restores it: `publishGene`
 * refuses to overwrite a *published* version but updates an unpublished one.
 *
 * Reads back the changed row rather than trusting the status code. RLS narrows
 * the UPDATE to rows the caller owns, and an UPDATE that matches nothing is not
 * an error in PostgREST — with `return=minimal` it answers 204, exactly like a
 * successful one. So a caller trying to unpublish someone else's gene would
 * have been told it worked. `return=representation` makes the two
 * distinguishable: no rows back means nothing was changed.
 *
 * The published artifact is deliberately left in storage. An unpublished gene
 * keeps its Arena row, and §9.7.1 asks that any published score stay
 * recomputable — deleting the binary would strand a score with no way to check
 * it, and would blind the `async-express-artifact` criterion that reads exactly
 * that file. (The previous best-effort delete never ran anyway: its URL omitted
 * the bucket segment, so the object path's first component was read as a bucket
 * name and the request failed with `NoSuchBucket` inside a catch that swallowed
 * it. Fixing that URL would have turned a silent no-op into real data loss.)
 */
export async function unpublishGene(id: string): Promise<UnpublishedGene> {
  const res = await fetch(apiUrl(`/genes?id=eq.${id}`), {
    method: "PATCH",
    headers: {
      ...authHeaders(true),
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ published: false }),
  });

  if (!res.ok) {
    throw new Error(`Failed to unpublish gene: ${await res.text()}`);
  }

  const changed = (await res.json()) as Array<{ id: string; name: string; version: string }>;
  if (changed.length === 0) {
    throw new Error(
      `Nothing was unpublished. Gene ${id} is either not yours or does not exist — ` +
        "only the author of a version can take it down."
    );
  }

  const row = changed[0];
  return { id: row.id, name: row.name, version: row.version };
}

/**
 * Put an unpublished version back on the public registry.
 *
 * The inverse of `unpublishGene`, and it has to exist as its own call:
 * `publishGene` always writes with a plain POST, so re-running it on a version
 * that is merely unpublished collides with
 * `genes_owner_id_name_version_key (owner_id, name, version)` instead of
 * restoring it. Without this, unpublishing would be a one-way door for an
 * author — the version could only come back under a new number.
 *
 * Immutability is preserved rather than bent: nothing but the `published` flag
 * moves, so the artifact and content hash that were published under this
 * version are the ones that come back.
 *
 * Same zero-row check as unpublish, for the same reason — RLS narrows the
 * UPDATE and PostgREST does not treat "matched nothing" as an error.
 */
export async function republishGene(id: string): Promise<UnpublishedGene> {
  const res = await fetch(apiUrl(`/genes?id=eq.${id}`), {
    method: "PATCH",
    headers: {
      ...authHeaders(true),
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ published: true }),
  });

  if (!res.ok) {
    throw new Error(`Failed to republish gene: ${await res.text()}`);
  }

  const changed = (await res.json()) as Array<{ id: string; name: string; version: string }>;
  if (changed.length === 0) {
    throw new Error(
      `Nothing was republished. Gene ${id} is either not yours or does not exist — ` +
        "only the author of a version can put it back."
    );
  }

  const row = changed[0];
  return { id: row.id, name: row.name, version: row.version };
}

/** One of the caller's own versions, for resolving what `unpublish` should act on. */
export interface OwnedGeneVersion {
  id: string;
  name: string;
  version: string;
  published: boolean;
  created_at: string;
}

/**
 * The caller's own versions of a gene, newest first.
 *
 * Scoped to `owner_id` rather than searching the public registry: only an author
 * can unpublish, so resolving a bare name against someone else's gene would only
 * produce a confusing permission error later.
 */
export async function listOwnGeneVersions(name: string): Promise<OwnedGeneVersion[]> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in. Run 'rotifer login' first.");

  const params = new URLSearchParams();
  params.set("owner_id", `eq.${creds.user.id}`);
  params.set("name", `eq.${name}`);
  params.set("select", "id,name,version,published,created_at");
  params.set("order", "created_at.desc");

  const res = await fetch(apiUrl(`/genes?${params}`), { headers: authHeaders(true) });
  return handleResponse<OwnedGeneVersion[]>(res);
}

export async function downloadGeneWasm(wasmUrl: string): Promise<Buffer> {
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`Failed to download WASM (${res.status})`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function trackDownload(
  geneId: string,
  source: "cli" | "mcp" | "api" | "web" = "cli",
): Promise<void> {
  try {
    const res = await fetch(apiUrl("/rpc/track_download"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ p_gene_id: geneId, p_source: source }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(
        `[rotifer] track_download failed (${res.status}): ${body}\n`
      );
    }
  } catch (err: any) {
    process.stderr.write(
      `[rotifer] track_download error: ${err?.message ?? err}\n`
    );
  }
}

// --- Cloud Arena ---

/** One sandbox run's raw measurements (ADR-319 D3). */
export interface EvaluationRun {
  run_index: number;
  sandbox_success: boolean;
  /** null when nothing was checkable — no usable outputSchema, or no output. */
  output_schema_valid: boolean | null;
  latency_ms: number;
  resource_cost: number;
}

/**
 * Publish the per-run measurements a submission was computed from.
 *
 * An Arena row states a score; without these it states it on trust, and
 * §9.7.1's promise that anyone can recompute the rankings is empty. These
 * rows are public and append-only, so a third party can apply the ADR-318
 * formula to the same inputs and check the answer.
 *
 * `evaluator` is not sent — the server stamps it from the authenticated
 * principal, for the same reason it does on arena_entries.
 */
export async function publishEvaluationRuns(
  geneId: string,
  submissionId: string,
  runs: EvaluationRun[]
): Promise<void> {
  if (runs.length === 0) return;

  const res = await fetch(apiUrl("/arena_evaluation_runs"), {
    method: "POST",
    headers: { ...authHeaders(true), Prefer: "return=minimal" },
    body: JSON.stringify(
      runs.map((r) => ({ gene_id: geneId, submission_id: submissionId, ...r })),
    ),
  });

  await handleResponse<unknown>(res);
}

export async function arenaSubmit(
  geneId: string,
  fitness: FitnessReport
): Promise<CloudArenaEntry> {
  const gene = await getGene(geneId);

  // Provenance travels with the numbers. `evaluator` is deliberately not sent:
  // the server stamps it from the authenticated principal, because a
  // self-reported "who measured this" is worth nothing (ADR-319 D2).
  const body: Record<string, unknown> = {
    gene_id: geneId,
    domain: gene.domain,
    fitness_value: fitness.value,
    safety_score: fitness.safety_score,
    success_rate: fitness.success_rate,
    latency_score: fitness.latency_score,
    resource_efficiency: fitness.resource_efficiency,
  };
  if (fitness.evaluation_method) body.evaluation_method = fitness.evaluation_method;
  if (fitness.evaluation_n !== undefined) body.evaluation_n = fitness.evaluation_n;
  // Both or neither — the ledger's pair constraint refuses half, and half
  // would reconstruct nothing anyway.
  if (fitness.base_fitness !== undefined && fitness.fidelity_discount !== undefined) {
    body.base_fitness = fitness.base_fitness;
    body.fidelity_discount = fitness.fidelity_discount;
  }

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

export interface ProfileSummary {
  id: string;
  username: string;
  avatar_url: string | null;
}

/**
 * Look up a profile (user) by username. Returns null when no profile matches.
 *
 * Used by `rotifer reputation @username` to resolve the @-handle into the
 * UUID that `getDeveloperReputation` requires. Without this, passing the
 * @-handle straight through ends up in a `user_id=eq.@username` query that
 * PostgreSQL rejects with a UUID-parse error (Issue #50 Bug 3).
 */
export async function getProfileByUsername(
  username: string,
): Promise<ProfileSummary | null> {
  const params = new URLSearchParams();
  params.set("username", `eq.${username}`);
  params.set("select", "id,username,avatar_url");
  params.set("limit", "1");

  const res = await fetch(apiUrl(`/profiles?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);
  if (data.length === 0) return null;
  return {
    id: data[0].id,
    username: data[0].username,
    avatar_url: data[0].avatar_url ?? null,
  };
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
    return {
      gene_name: geneId,
      score: 0,
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
    return {
      score: 0,
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

export async function getGeneStats(idOrName: string): Promise<GeneStatsResponse> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
  let geneId = idOrName;
  if (!isUuid) {
    const gene = await getGene(idOrName);
    geneId = gene.id;
  }
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

// --- Epoch Compute Log ---

export interface ComputeLogEntry {
  id: string;
  compute_type: string;
  affected_count: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_message: string | null;
}

export async function getReputationComputeLog(limit: number = 10): Promise<ComputeLogEntry[]> {
  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "started_at.desc");
  params.set("limit", String(limit));

  const res = await fetch(apiUrl(`/reputation_compute_log?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);

  return data.map((row) => ({
    id: row.id,
    compute_type: row.compute_type,
    affected_count: row.affected_count ?? 0,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    status: row.status,
    error_message: row.error_message ?? null,
  }));
}

// --- ContributionMetrics (§23.1) ---

export async function getContributionMetrics(geneId: string): Promise<ContributionMetrics> {
  const params = new URLSearchParams();
  params.set("gene_id", `eq.${geneId}`);
  params.set("select", "*");

  const res = await fetch(apiUrl(`/gene_contribution_metrics?${params}`), {
    headers: authHeaders(),
  });
  const data = await handleResponse<any[]>(res);

  if (data.length === 0) {
    return {
      gene_id: geneId,
      total_invocations: 0,
      unique_callers: 0,
      invocations_last_30d: 0,
      derivation_count: 0,
      composition_count: 0,
      downstream_success_rate: 1.0,
      updated_at: new Date().toISOString(),
    };
  }

  const row = data[0];
  return {
    gene_id: row.gene_id,
    total_invocations: row.total_invocations ?? 0,
    unique_callers: row.unique_callers ?? 0,
    invocations_last_30d: row.invocations_last_30d ?? 0,
    derivation_count: row.derivation_count ?? 0,
    composition_count: row.composition_count ?? 0,
    downstream_success_rate: row.downstream_success_rate ?? 1.0,
    updated_at: row.updated_at,
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
