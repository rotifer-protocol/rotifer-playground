# ClawHub fixture

What `wrap --from-clawhub` receives from ClawHub, recorded in shape (2026-10-31)
with synthetic content:

- `info.json`: the metadata endpoint's answer — the same keys and types as
  `https://clawhub.ai/api/skill?slug=...`.
- `fixture-skill/`: the package. The tests zip it flat, as the real download
  is (SKILL.md, _meta.json, README.md at the top level).
- `ambiguous-409.txt`, `ambiguous-409-matches.json`: ClawHub's answers for a
  slug more than one publisher uses, recorded from the real ClawHub on
  2026-11-23, with the publishers renamed to synthetic ones (alice-demo,
  bob-demo). The text is the plain-text 409 from `/api/skill` (and
  `/api/v1/download`); the JSON is the 409 from `/api/v1/skills/<slug>`, the
  only answer that lists the publishers. Used by
  `tests/e2e/clawhub-ambiguous.test.ts` and `tests/unit/clawhub-skill-ref.test.ts`.

PR CI runs `tests/e2e/clawhub-wrap.test.ts` against these. The real endpoints
are checked on a schedule by `tests/live/clawhub-live.test.ts`
(`.github/workflows/live-checks.yml`); if ClawHub changes shape, that check
fails and this fixture is updated to match.
