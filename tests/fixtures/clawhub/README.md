# ClawHub fixture

What `wrap --from-clawhub` receives from ClawHub, recorded in shape (2026-10-31)
with synthetic content:

- `info.json`: the metadata endpoint's answer — the same keys and types as
  `https://clawhub.ai/api/skill?slug=...`.
- `fixture-skill/`: the package. The tests zip it flat, as the real download
  is (SKILL.md, _meta.json, README.md at the top level).

PR CI runs `tests/e2e/clawhub-wrap.test.ts` against these. The real endpoints
are checked on a schedule by `tests/live/clawhub-live.test.ts`
(`.github/workflows/clawhub-live.yml`); if ClawHub changes shape, that check
fails and this fixture is updated to match.
