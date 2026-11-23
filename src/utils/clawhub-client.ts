/**
 * The two ClawHub endpoints `wrap --from-clawhub` uses: skill metadata and
 * the skill package.
 *
 * Both sit in front of ClawHub's Convex backend, which is slow (4–11 s per
 * answer) and fails about one request in six with HTTP 500
 * `[Request ID: …] Server Error` — from any network, measured 2026-10-31.
 * So every request here has a timeout, transient failures (5xx, 408, 429, a
 * timeout, a network error) are retried with backoff, and a failure that
 * survives the retries says exactly what it was: a 404 is "not found", a 500
 * carries ClawHub's own message, a non-JSON answer names its content type.
 * Before this, all of them read "not found or API error", which is how a
 * flaky upstream passed for a missing skill.
 *
 * `fetch` follows 301/302/307/308. The download endpoint answers 307, which
 * an earlier hand-written client did not follow (2026-08-31).
 *
 * A slug can belong to more than one publisher. ClawHub then answers 409 and
 * wants the publisher named (`ownerHandle`); people write it `@owner/slug`,
 * the form ClawHub's own `ref` field and CLI use. Which publisher to install
 * is the user's choice, so an ambiguous slug is an error that lists the
 * publishers, never a pick.
 */

export const CLAWHUB_API = "https://clawhub.ai/api/skill";
export const CLAWHUB_DOWNLOAD = "https://wry-manatee-359.convex.site/api/v1/download";

export interface ClawHubSkillInfo {
  slug: string;
  displayName: string;
  summary: string;
  stats: { downloads: number; stars: number; versions: number; installs?: number };
  owner: { handle: string; displayName: string };
  version: string;
}

export type ClawHubFailureKind = "not_found" | "ambiguous" | "http" | "not_json" | "timeout" | "network";

export class ClawHubError extends Error {
  constructor(
    readonly kind: ClawHubFailureKind,
    readonly url: string,
    readonly attempts: number,
    readonly status: number | undefined,
    readonly detail: string,
    /** For "ambiguous": the publishers' `@owner/slug` refs, when ClawHub listed them. */
    readonly candidates: string[] = [],
  ) {
    super(describeFailure(kind, attempts, status, detail));
    this.name = "ClawHubError";
  }
}

function describeFailure(
  kind: ClawHubFailureKind,
  attempts: number,
  status: number | undefined,
  detail: string,
): string {
  const tries = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  switch (kind) {
    case "not_found":
      return `not found (HTTP ${status ?? 404})`;
    case "ambiguous":
      return `is used by more than one publisher (HTTP ${status ?? 409})`;
    case "http":
      return `HTTP ${status}${detail ? ` — ${detail}` : ""} (${tries})`;
    case "not_json":
      return `the response was not JSON (${detail}) (${tries})`;
    case "timeout":
      return `no answer within ${detail} (${tries})`;
    case "network":
      return `network error: ${detail} (${tries})`;
  }
}

export interface ClawHubRequestOptions {
  /** Attempts in all, the first included. */
  attempts?: number;
  /** Per attempt, response body included. */
  timeoutMs?: number;
  /** Wait before attempt n+1; the last entry repeats. */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
  /** Told about each failed attempt that will be retried. */
  onRetry?: (attempt: number, attempts: number, error: ClawHubError) => void;
}

const DEFAULTS = {
  attempts: 3,
  // A successful answer takes up to ~11 s; leave room above that.
  timeoutMs: 30_000,
  retryDelaysMs: [1_000, 3_000],
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The endpoints, or the overrides in ROTIFER_CLAWHUB_API_URL /
 * ROTIFER_CLAWHUB_DOWNLOAD_URL (a mirror, or a local fixture in tests). An
 * override must be https, or plain http to a loopback address; anything else
 * is refused rather than silently sending requests somewhere unencrypted.
 */
export function clawHubEndpoints(env: NodeJS.ProcessEnv = process.env): { api: string; download: string } {
  return {
    api: checkedOverride("ROTIFER_CLAWHUB_API_URL", env.ROTIFER_CLAWHUB_API_URL) ?? CLAWHUB_API,
    download: checkedOverride("ROTIFER_CLAWHUB_DOWNLOAD_URL", env.ROTIFER_CLAWHUB_DOWNLOAD_URL) ?? CLAWHUB_DOWNLOAD,
  };
}

function checkedOverride(name: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return value;
  }
  throw new Error(`${name} must be https, or http to a loopback address: ${value}`);
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** ClawHub's error text: the `code` / `message` / `error` field, or the body. */
function errorDetail(body: string): string {
  let text = body.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const field = ["code", "message", "error"].map((k) => parsed[k]).find((v) => typeof v === "string");
    if (typeof field === "string") text = field;
  } catch {
    // not JSON: keep the text
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

interface Answer {
  status: number;
  contentType: string;
  body: Buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url: string, options: ClawHubRequestOptions): Promise<Answer> {
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const delays = options.retryDelaysMs ?? DEFAULTS.retryDelaysMs;
  const doFetch = options.fetchImpl ?? fetch;

  let last: ClawHubError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let failure: ClawHubError;
    try {
      const res = await doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status === 200) {
        return { status: 200, contentType: res.headers.get("content-type") ?? "", body };
      }
      const detail = errorDetail(body.toString("utf-8"));
      if (res.status === 404) throw new ClawHubError("not_found", url, attempt, 404, detail);
      if (res.status === 409) throw new ClawHubError("ambiguous", url, attempt, 409, detail);
      failure = new ClawHubError("http", url, attempt, res.status, detail);
      if (!isTransientStatus(res.status)) throw failure;
    } catch (e) {
      if (e instanceof ClawHubError) throw e;
      const err = e as Error & { cause?: { code?: string; message?: string } };
      failure =
        err.name === "TimeoutError" || err.name === "AbortError"
          ? new ClawHubError("timeout", url, attempt, undefined, timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`)
          : new ClawHubError(
              "network",
              url,
              attempt,
              undefined,
              err.cause?.code ?? err.cause?.message ?? err.message,
            );
    }
    last = failure;
    if (attempt < attempts) {
      options.onRetry?.(attempt, attempts, failure);
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  throw last!;
}

export interface ClawHubSkillRef {
  slug: string;
  /** The publisher, when named: `@owner/slug`. */
  ownerHandle?: string;
}

export class InvalidSkillRef extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `slug` or `@owner/slug`. Anything else is refused rather than guessed at. */
export function parseSkillRef(ref: string): ClawHubSkillRef {
  const owned = /^@([^/]+)\/([^/]+)$/.exec(ref);
  if (owned && NAME.test(owned[1]) && NAME.test(owned[2])) return { slug: owned[2], ownerHandle: owned[1] };
  if (NAME.test(ref)) return { slug: ref };
  throw new InvalidSkillRef(
    `'${ref}' is not a ClawHub skill: give its slug, or @owner/slug to name the publisher (for example @owner/my-skill)`,
  );
}

function withRef(endpoint: string, slug: string, ownerHandle: string | undefined): string {
  const owner = ownerHandle ? `&ownerHandle=${encodeURIComponent(ownerHandle)}` : "";
  return `${endpoint}?slug=${encodeURIComponent(slug)}${owner}`;
}

/**
 * The publishers of an ambiguous slug, as `@owner/slug`. Only ClawHub's v1
 * skill endpoint lists them (in its 409 answer); the metadata endpoint says
 * only that there is more than one. One attempt, and any failure is an empty
 * list: this only improves an error message.
 */
export async function fetchClawHubCandidates(
  slug: string,
  options: ClawHubRequestOptions & { api?: string } = {},
): Promise<string[]> {
  const api = options.api ?? clawHubEndpoints().api;
  if (!api.endsWith("/api/skill")) return [];
  const url = `${api.slice(0, -"/api/skill".length)}/api/v1/skills/${encodeURIComponent(slug)}`;
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULTS.timeoutMs),
    });
    const data = (await res.json()) as { matches?: unknown };
    if (!Array.isArray(data.matches)) return [];
    const refs = data.matches
      .map((m) => (m as { ref?: unknown })?.ref)
      .filter((r): r is string => typeof r === "string")
      .filter((r) => {
        try {
          const parsed = parseSkillRef(r);
          return parsed.slug === slug && parsed.ownerHandle !== undefined;
        } catch {
          return false;
        }
      });
    return [...new Set(refs)];
  } catch {
    return [];
  }
}

export async function fetchClawHubInfo(
  slug: string,
  options: ClawHubRequestOptions & { api?: string; ownerHandle?: string } = {},
): Promise<ClawHubSkillInfo> {
  const url = withRef(options.api ?? clawHubEndpoints().api, slug, options.ownerHandle);
  let answer: Answer;
  try {
    answer = await request(url, options);
  } catch (e) {
    if (e instanceof ClawHubError && e.kind === "ambiguous") {
      throw new ClawHubError(e.kind, e.url, e.attempts, e.status, e.detail, await fetchClawHubCandidates(slug, options));
    }
    throw e;
  }
  let data: {
    skill?: { slug: string; displayName: string; summary: string; stats: ClawHubSkillInfo["stats"] };
    owner?: { handle?: string; displayName?: string };
    latestVersion?: { version?: string };
  };
  try {
    data = JSON.parse(answer.body.toString("utf-8"));
  } catch {
    throw new ClawHubError("not_json", url, 1, 200, `content-type ${answer.contentType || "unknown"}`);
  }
  if (!data.skill) throw new ClawHubError("not_found", url, 1, 200, "the answer names no skill");
  return {
    slug: data.skill.slug,
    displayName: data.skill.displayName,
    summary: data.skill.summary,
    stats: data.skill.stats,
    owner: { handle: data.owner?.handle || "unknown", displayName: data.owner?.displayName || "" },
    version: data.latestVersion?.version || "0.0.0",
  };
}

/** The skill package (a zip). */
export async function fetchClawHubPackage(
  slug: string,
  options: ClawHubRequestOptions & { download?: string; ownerHandle?: string } = {},
): Promise<Buffer> {
  const url = withRef(options.download ?? clawHubEndpoints().download, slug, options.ownerHandle);
  return (await request(url, options)).body;
}
