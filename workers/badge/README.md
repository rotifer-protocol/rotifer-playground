# badge-worker

Cloudflare Worker powering `badge.rotifer.dev` — the trust badge API for Rotifer Protocol.

Returns [shields.io Endpoint Badge](https://shields.io/endpoint) compatible JSON responses for safety grades, gene reputation, fitness scores, and creator reputation.

## Routes

| Route | Description | Data Source |
|-------|-------------|-------------|
| `GET /safety/:skill_id` | V(g) safety grade | Worker KV |
| `GET /gene/:identifier` | Gene reputation score | Supabase `genes` |
| `GET /gene/:identifier/fitness` | Arena fitness F(g) | Supabase `arena_entries` |
| `GET /dev/:username` | Creator reputation | Supabase `developer_reputation` |

Gene identifiers accept UUIDs, plain names, or qualified names (`@owner/gene-name`).

## Development

This Worker is a standalone npm package inside `rotifer-playground`; the root `package.json` does not build or test it. Run everything from `workers/badge/`:

```bash
cd workers/badge
npm ci             # install the pinned dependencies
npm run dev        # wrangler dev
npm test           # vitest: tests/badge.test.ts, tests/badge-security.test.ts
```

The tests use an in-memory KV stub and need no Cloudflare or Supabase credentials.

## Deployment

```bash
npx wrangler deploy
```

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables. Supabase credentials are configured via `wrangler secret`:

```bash
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put BADGE_AUTH_TOKEN   # bearer token required by POST /safety
```

## Configuration

See `wrangler.toml` for Worker name, KV namespace binding, and environment variables.

## Usage

Embed badges in Markdown via shields.io:

```markdown
![Safety](https://img.shields.io/endpoint?url=https://badge.rotifer.dev/safety/@author/skill-name)
```

See the [Badge Generator](https://rotifer.ai/badge.html) for an interactive tool, or the [Trust Badges guide](https://rotifer.dev/docs/guides/badges/) for full documentation.
