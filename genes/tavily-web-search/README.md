# tavily-web-search

Live web search through the [Tavily](https://tavily.com) API. Same input and output as `genesis-web-search`, but the results are real.

- **Fidelity:** Hybrid. It calls one host, `api.tavily.com`, through `rotifer.net.fetch`.
- **Key:** your own Tavily API key, in the `TAVILY_API_KEY` environment variable. Tavily's free tier is 1,000 searches a month and needs no card.
- **Status:** `nonstandard` preview (spec §25.4). The `rotifer.net` / `rotifer.env` host modules and the `credentials` field come from ADR-327 and are not in the formal spec yet.
- **Not in the npm package** (D31). Get it from this repository.

## Input and output

```json
{ "query": "WebAssembly component model", "maxResults": 3 }
```

```json
{
  "results": [{ "title": "…", "url": "https://…", "snippet": "…" }],
  "totalResults": 3,
  "searchTime": 840
}
```

`maxResults` is 1–20 (default 5). `searchTime` is Tavily's own response time in milliseconds, and is left out if Tavily does not report one.

## Build and run

The gene is Rust source. Build it, then turn the module into a gene with `rotifer compile --wasm`:

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown --manifest-path genes/tavily-web-search/Cargo.toml
rotifer compile tavily-web-search --wasm genes/tavily-web-search/target/wasm32-unknown-unknown/release/tavily_web_search.wasm
```

Set the key without echoing it, then search:

```bash
read -rs TAVILY_API_KEY && export TAVILY_API_KEY
rotifer run tavily-web-search --input '{"query":"WebAssembly component model","maxResults":3}'
```

## How the key is handled

The phenotype declares `TAVILY_API_KEY` in `externalDependencies[].credentials`, so the CLI reads that one environment variable and no other. The gene never sees the value. It sends the literal header `Authorization: Bearer ${env:TAVILY_API_KEY}`, and the host fills in the value as the request leaves the sandbox. The value is not written to the output, the logs or `.rotifer/audit.jsonl`.

If `TAVILY_API_KEY` is unset or empty, `rotifer run` stops before the gene runs:

```
✗ Execution failed: missing credential: the environment variable TAVILY_API_KEY is not set. …
```

## Errors

| Code | Meaning |
|---|---|
| -201 | Tavily rejected the key (HTTP 401 / 403) |
| -202 | Tavily's rate limit or your plan's usage limit (HTTP 429 / 432 / 433) |
| -203 | Any other error status from Tavily |
| -204 | Tavily answered, but not in a form this gene can read |
| -3 | The request went to a host other than `api.tavily.com` |
| -4 / -5 | Timeout / network failure |

A missing or empty `query`, or a `maxResults` outside 1–20, is refused as `INVALID_INPUT` without a search.

## Tests

- `cargo test --manifest-path genes/tavily-web-search/Cargo.toml`: input checks, the request it builds, and how Tavily's answers map to output and codes.
- `cargo test -p rotifer-core tavily_gene_tests`: builds this module and runs it in the real sandbox against a local fake Tavily. It checks that the key appears only in the `Authorization` header the fake receives, and never in the body, output or metadata. It also checks that a host outside the whitelist and a missing key are both refused before anything is sent.
- `testsuite.json` calls the real API, so it needs a key. It is what `rotifer test` and the publishing gate run.
