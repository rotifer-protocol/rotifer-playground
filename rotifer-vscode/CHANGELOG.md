# Changelog

## 0.8.5 — 2026-04-08

Public release-line consolidation for the current `v0.8.5` Rotifer surface across CLI, MCP, website docs, and IDE distribution metadata.

## 0.8.1 — 2026-03-28

Version bump aligned with CLI v0.8.1 (Ecosystem Reach release).

## 0.7.8 — 2026-02-17

### Added

- **Integration tests** — 3 new files: offline fallback, auth expiry, publish flow (10 tests)
- Test coverage: 27 → **37 tests** (+10)

## 0.7.7 — 2026-02-17

Version bump aligned with CLI v0.7.7 and MCP Server v0.7.7 release.

## 0.7.6 — 2026-02-17

Full feature parity with CLI v0.7.6 and MCP Server v0.7.6.

### Added

- **Auth**: OAuth login/logout via GitHub or GitLab with status bar indicator
- **Search**: Gene search via Quick Pick with name/description filtering
- **Local Genes**: Tree view for browsing local genes grouped by domain
- **Arena Rankings**: Tree view showing Arena competition rankings by domain
- **Gene Statistics**: Download statistics webview (7d/30d/90d/total)
- **Version History**: Version chain webview with changelog display
- **Gene Comparison**: Side-by-side comparison of 2-5 genes
- **Creator Leaderboard**: Reputation leaderboard webview
- **My Reputation**: Personal reputation stats (requires auth)
- **Local Operations**: Init, scan, wrap, test, compile, run commands via terminal
- **Agent Management**: Create, list, run agents via terminal
- **Arena Submit**: Submit local genes to Arena competition
- **Dynamic Domains**: Publish flow fetches domain list from Cloud
- **Changelog Input**: Publish flow includes changelog step

### Changed

- Version jumped from 0.1.1 to 0.7.6 to align with main project (Plan C strategy)
- 26 commands registered (up from 5)
- 3 tree views (up from 1): Gene Registry, Local Genes, Arena Rankings
- Webview panels: Gene Details, Reputation, Stats, Versions, Leaderboard, My Reputation, Comparison

## 0.1.1 — 2026-03-17

### Improved

- Added 256×256 extension icon for Marketplace visibility
- Set public Supabase anon key as default (works out-of-the-box, no configuration needed)
- Optimized package size via expanded .vscodeignore

## 0.1.0 — 2026-02-28

Initial release.

### Added

- Gene Registry browser with domain-grouped tree view
- One-click gene installation to workspace
- Gene details webview (name, domain, fidelity, version, schemas, downloads)
- Gene reputation panel (Arena / Usage / Stability breakdown)
- SKILL.md → Gene publish command (right-click context menu)
- Configurable Cloud endpoint and anon key
