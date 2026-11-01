# Rotifer Cloud fixture

A recorded Rotifer Cloud for the e2e suites whose commands read the registry:
`versions`, `info`, `stats`, `install` and `reputation`
(`tests/e2e/{list-run-versions,info-stats-compare,install-edge,reputation}.test.ts`).

- `registry.json`: the rows those calls get back. They have the same columns
  and types as the real PostgREST answers (recorded 2026-11-01), but the
  content is synthetic: `fixture-owner/fixture-gene` with two versions, and
  six leaderboard rows.
- `server.mjs`: answers `GET /rest/v1/genes` (with `eq.` filters, `order` and
  `limit`) and `POST /rest/v1/rpc/get_reputation_leaderboard` (with `p_limit`)
  from that file. Like the real API, it answers 401 "No API key found in
  request" when the `apikey` header is missing. Any other request gets 501
  and is listed at `GET /__unrecorded`. Each suite checks that list is empty
  when it finishes, so a new registry call fails the suite until it is
  recorded here.

`tests/e2e/recorded-cloud.ts` starts the server as a child process, so suites
that call the CLI with `execSync` can use it. The CLI reaches it through
`ROTIFER_CLOUD_ENDPOINT`.

The real cloud is checked by `tests/live/cloud-live.test.ts` on a schedule
(`.github/workflows/live-checks.yml`). If the real API changes shape, that
check fails, and this fixture is updated to match.
