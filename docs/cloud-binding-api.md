# Rotifer Cloud Binding — REST API Specification

> Version: 1.2.0-draft
> Date: 2026-03-22
> Status: Draft (§23.1 ContributionMetrics + invocation tracking added)

## Overview

The Cloud Binding API enables cross-creator gene sharing and remote Arena competition. Any server implementing this specification can serve as a Rotifer Cloud Binding endpoint.

**Design principles:**
- Infrastructure-agnostic — implementable on any cloud provider
- Local-first — all existing local CLI commands remain unaffected
- RESTful — standard HTTP methods, JSON payloads, Bearer auth

**Base URL pattern:** `{endpoint}/v1/`

---

## Authentication

All write endpoints require a Bearer token obtained via GitHub OAuth.

### `POST /v1/auth/login`

Initiate GitHub OAuth flow. Returns a URL for the user to authorize.

**Request:**
```json
{ "redirect_uri": "http://localhost:9876/callback" }
```

**Response (200):**
```json
{ "auth_url": "https://github.com/login/oauth/authorize?..." }
```

### `POST /v1/auth/callback`

Exchange OAuth code for access/refresh tokens.

**Request:**
```json
{ "code": "github_oauth_code" }
```

**Response (200):**
```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 3600,
  "user": {
    "id": "uuid",
    "username": "rotiferdev",
    "avatar_url": "https://...",
    "github_id": 12345
  }
}
```

### `POST /v1/auth/refresh`

Refresh an expired access token.

**Request:**
```json
{ "refresh_token": "eyJ..." }
```

**Response (200):**
```json
{
  "access_token": "eyJ...",
  "expires_in": 3600
}
```

---

## Gene Registry

### `GET /v1/genes`

List/search published genes.

**Query parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `domain` | string | Filter by domain (e.g., `search.web`) |
| `q` | string | Full-text search on name and description |
| `owner` | string | Filter by owner username |
| `fidelity` | string | Filter by `Native` or `Wrapped` |
| `sort` | string | `newest`, `popular`, `fitness` (default: `newest`) |
| `page` | number | Page number (default: 1) |
| `per_page` | number | Items per page (default: 20, max: 100) |

**Response (200):**
```json
{
  "genes": [
    {
      "id": "uuid",
      "name": "smart-search",
      "owner": "rotiferdev",
      "domain": "search.web",
      "version": "1.0.0",
      "fidelity": "Native",
      "description": "AI-powered web search gene",
      "downloads": 42,
      "fitness": 0.87,
      "created_at": "2026-02-17T12:00:00Z",
      "updated_at": "2026-02-17T12:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "per_page": 20
}
```

### `GET /v1/genes/:id`

Get gene details including download URL.

**Response (200):**
```json
{
  "id": "uuid",
  "name": "smart-search",
  "owner": "rotiferdev",
  "domain": "search.web",
  "version": "1.0.0",
  "fidelity": "Native",
  "description": "AI-powered web search gene",
  "phenotype": { "...full phenotype object..." },
  "wasm_url": "https://storage.../smart-search.ir.wasm",
  "wasm_size": 12288,
  "downloads": 42,
  "fitness": 0.87,
  "created_at": "2026-02-17T12:00:00Z",
  "updated_at": "2026-02-17T12:00:00Z"
}
```

### `POST /v1/genes` (Auth required)

Publish a gene to the cloud registry.

**Request:** `multipart/form-data`
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Gene name (unique per owner) |
| `domain` | string | Functional domain |
| `version` | string | SemVer version |
| `phenotype` | JSON | Full phenotype object |
| `wasm` | file | WASM binary (gene.ir.wasm) |

**Response (201):**
```json
{
  "id": "uuid",
  "name": "smart-search",
  "owner": "rotiferdev",
  "domain": "search.web",
  "version": "1.0.0",
  "wasm_url": "https://storage.../smart-search.ir.wasm"
}
```

**Errors:**
- `409 Conflict` — Gene with same name+version already exists for this owner
- `413 Payload Too Large` — WASM exceeds 10MB limit
- `422 Unprocessable Entity` — Invalid phenotype or missing required fields

### `DELETE /v1/genes/:id` (Auth required, owner only)

Unpublish a gene.

**Response (204):** No content.

**Errors:**
- `403 Forbidden` — Not the owner
- `404 Not Found` — Gene not found

---

## Cloud Arena

### `POST /v1/arena/submit` (Auth required)

Submit a gene to the cloud Arena.

**Request:**
```json
{
  "gene_id": "uuid",
  "fitness": {
    "value": 0.87,
    "safety_score": 0.95,
    "success_rate": 0.98,
    "latency_score": 0.82,
    "resource_efficiency": 0.76
  }
}
```

**Response (200):**
```json
{
  "gene_id": "uuid",
  "domain": "search.web",
  "rank": 3,
  "fitness": 0.87,
  "total_in_domain": 12
}
```

**Errors:**
- `404 Not Found` — Gene not published
- `403 Forbidden` — Not the gene owner

### `GET /v1/arena/rankings`

Get cloud Arena rankings.

**Query parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `domain` | string | Filter by domain |
| `page` | number | Page number (default: 1) |
| `per_page` | number | Items per page (default: 50) |

**Response (200):**
```json
{
  "rankings": [
    {
      "rank": 1,
      "gene_id": "uuid",
      "gene_name": "genesis-web-search",
      "owner": "rotifer-protocol",
      "domain": "search.web",
      "fidelity": "Native",
      "fitness": 0.92,
      "safety": 0.98,
      "total_calls": 1234,
      "last_evaluated": "2026-02-17T12:00:00Z"
    }
  ],
  "total": 1,
  "domain": "search.web"
}
```

### `GET /v1/arena/rankings/stream`

Server-Sent Events (SSE) stream for real-time ranking updates.

**Query parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `domain` | string | Filter by domain (optional) |

**Event format:**
```
event: rank_change
data: {"gene_name":"smart-search","old_rank":5,"new_rank":3,"fitness":0.87}

event: new_entry
data: {"gene_name":"fast-search","rank":7,"fitness":0.72}
```

---

## Users

### `GET /v1/users/:username`

Get creator public profile.

**Response (200):**
```json
{
  "id": "uuid",
  "username": "rotiferdev",
  "avatar_url": "https://...",
  "genes_count": 5,
  "total_downloads": 128,
  "joined_at": "2026-02-17T12:00:00Z"
}
```

---

## Epoch Compute Log

### `GET /v1/reputation_compute_log`

Query Epoch computation history. Shows when reputation computations ran and their results.

**Query parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Max entries to return (default: 10) |

**Response (200):**
```json
[
  {
    "id": "uuid",
    "compute_type": "contribution_metrics",
    "affected_count": 70,
    "started_at": "2026-03-22T00:00:01Z",
    "finished_at": "2026-03-22T00:00:02Z",
    "status": "success",
    "error_message": null
  }
]
```

**Notes:**
- `compute_type` values: `contribution_metrics`, `gene`, `developer`
- Idempotent per day (only one successful run per day)

---

## Contribution Metrics (§23.1)

### `GET /v1/genes/:id/metrics`

Get contribution metrics for a gene. Publicly readable per §9.7.1 data transparency.

**Response (200):**
```json
{
  "gene_id": "uuid",
  "total_invocations": 1234,
  "unique_callers": 42,
  "invocations_last_30d": 87,
  "derivation_count": 3,
  "composition_count": 5,
  "downstream_success_rate": 0.92,
  "updated_at": "2026-03-22T00:00:00Z"
}
```

### `POST /v1/rpc/log_gene_invocation` (authenticated)

Record one execution of a Cloud-installed gene. Called by the clients that
actually run genes — the CLI (`rotifer run`, `rotifer agent run`) and the MCP
server (`run_gene`) — with the caller's own JWT. Both send it fire-and-forget
and only when all three hold: the gene has a Cloud identity
(`.cloud-manifest.json`), the user is signed in, and `ROTIFER_TELEMETRY` is not
`0` / `false` / `off`. Signed out, nothing is sent.

These rows are the raw input to `gene_contribution_metrics` and therefore to
the §33.4 anti-manipulation rules (self-invocation exclusion, unique-caller
threshold, dedup windows).

**Request:**
```json
{
  "p_gene_id": "uuid",
  "p_caller_agent_id": "agent-identity-string"
}
```

**Response (200):**
```json
"uuid"
```

**Notes:**
- Callable by `authenticated` (migration `20260527020805`); `anon` is refused
- `gene_author_id` is auto-populated via trigger
- `is_self_invocation` is a generated column for §33.4 Rule 1

---

## Error Format

All errors follow a consistent format:

```json
{
  "error": {
    "code": "GENE_NOT_FOUND",
    "message": "Gene with id 'xxx' not found",
    "status": 404
  }
}
```

## Security

The Cloud Binding backend enforces security at the database level via PostgreSQL Row-Level Security (RLS) and function-level access controls. All policies were formally audited in v0.7.

### Row-Level Security (RLS)

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| `profiles` | Public (read-only) | Auth trigger only | Own row only | — |
| `genes` | Published genes only | Creator (authenticated) | Own genes only | Own genes only |
| `arena_entries` | Public | Authenticated | Authenticated | — |
| `downloads` | Public | Authenticated only | — | — |
| `gene_reputation` | Public (read-only) | **Blocked** (server-side compute only) | — | — |
| `developer_reputation` | Public (read-only) | **Blocked** (server-side compute only) | **Blocked** | — |
| `gene_invocation_log` | Public (§9.7.1 transparency) | **Blocked** (only via `log_gene_invocation()` RPC) | — | — |
| `gene_contribution_metrics` | Public (§9.7.1 transparency) | **Blocked** (refresh function only) | **Blocked** | — |

### Function Access Controls

| Function | Access | Notes |
|----------|--------|-------|
| `get_arena_rankings()` | Public | Query capped at 200 results |
| `get_gene_stats()` | Public | Only returns data for published genes |
| `get_reputation_leaderboard()` | Public | Query capped at 100 results |
| `compute_gene_reputation()` | Authenticated | `SECURITY DEFINER`; writes to `gene_reputation` on behalf of caller |
| `compute_developer_reputation()` | Authenticated | `SECURITY DEFINER`; writes to `developer_reputation` on behalf of caller |
| `apply_reputation_decay()` | **service_role only** | `SECURITY DEFINER`; intended for cron/admin use |
| `refresh_contribution_metrics()` | **service_role only** | `SECURITY DEFINER`; called by `compute_all_reputations()` |
| `log_gene_invocation()` | Authenticated | `SECURITY DEFINER`; CLI / MCP invocation record (signed in + telemetry on) |
| `cleanup_old_invocation_logs()` | **service_role only** | `SECURITY DEFINER`; weekly cron, retains 90d for §33.4 loop detection |
| `handle_new_user()` | Auth trigger | `SECURITY DEFINER`; sanitizes OAuth username, validates avatar URL |

### Audit History

| Version | Migration | Scope |
|---------|-----------|-------|
| v0.7 | `005_security_hardening.sql` | Fixed 2 CRITICAL + 5 WARNING findings (C1, C2, W1–W5) |
| v0.7 | `006_revoke_anon_execute.sql` | Revoked `anon` EXECUTE on restricted functions (Supabase-specific) |
| v0.8 | `20260322120000_contribution_metrics.sql` | ContributionMetrics data model + invocation tracking (§23.1) |

See the security audit report for details.

## Rate Limiting

- Unauthenticated: 60 requests/hour
- Authenticated: 1000 requests/hour
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## CLI Command Mapping

| CLI Command | HTTP Method | Endpoint |
|------------|-------------|----------|
| `rotifer login` | POST | `/v1/auth/login` + `/v1/auth/callback` |
| `rotifer logout` | — | Local token deletion |
| `rotifer publish <gene>` | POST | `/v1/genes` |
| `rotifer search [query]` | GET | `/v1/genes` |
| `rotifer install <gene-ref>` | GET | `/v1/genes/:id` |
| `rotifer arena submit --cloud` | POST | `/v1/arena/submit` |
| `rotifer arena list --cloud` | GET | `/v1/arena/rankings` |
| `rotifer arena watch --cloud` | GET | `/v1/arena/rankings/stream` |
