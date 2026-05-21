# Contributing to Rotifer Playground

Thank you for your interest in contributing to the Rotifer Protocol Playground.

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- Rust stable toolchain (for core library development)
- Git

### Getting Started

```bash
git clone https://github.com/rotifer-protocol/rotifer-playground.git
cd playground
npm install
npm run build
npm test
```

### Project Structure

```
playground/
├── crates/
│   ├── rotifer-core/     # Rust core library
│   └── rotifer-napi/     # napi-rs bridge to Node.js
├── src/                  # TypeScript CLI
│   ├── commands/         # 10 CLI commands
│   ├── utils/            # Config, display helpers
│   └── errors/           # Error formatting
├── genes/                # 5 Genesis genes
├── templates/            # Gene and composition templates
└── tests/                # Unit and E2E tests
```

## Workflow

### Branch Naming

- `feat/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code refactoring
- `docs/description` — documentation changes
- `test/description` — test additions or fixes

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(arena): add domain filtering to rankings
fix(sandbox): correct fuel limit overflow
docs(readme): update quick start section
test(e2e): add three-act demo validation
```

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all tests pass: `npm test`
4. Ensure TypeScript compiles: `npm run lint`
5. If modifying Rust code: `cargo check -p rotifer-core`
6. Open a PR with a clear description

### CI Checks

PRs must pass:
- TypeScript type checking (`tsc --noEmit`)
- All unit and E2E tests (`vitest run`)
- Rust compilation (`cargo check`) — if Rust files changed

## Architecture Decisions

Major decisions are documented as ADRs (Architecture Decision Records) in the specification repository. Key ADRs for Playground development:

- **ADR-08**: MVP Scope (P0/P1/P2 classification)
- **ADR-09**: Implementation Architecture (TS CLI + Rust Core + napi-rs)
- **ADR-10**: Genesis Gene Selection
- **ADR-11**: Developer Experience Strategy (three-act Demo)
- Testing and Acceptance Standards

## Adding a New CLI Command

1. Create `src/commands/your-command.ts`
2. Export a `Command` instance using commander.js
3. Register it in `src/index.ts`
4. Add tests in `tests/`
5. Update `README.md` command table

## Adding a Genesis Gene

1. Create `genes/genesis-your-gene/phenotype.json`
2. Create `genes/genesis-your-gene/index.ts` with `express()` function
3. Add to `GENESIS_GENES` array in `src/commands/init.ts`
4. Run `rotifer compile genesis-your-gene` to generate WASM (compiled genes run in the WASM sandbox with fuel metering and L0 gate checks)
5. Run `rotifer test genesis-your-gene --compliance` to verify structural compliance
6. Add tests in `tests/unit/genesis-genes.test.ts`

## Protocol Compliance

When implementing spec features:

1. Reference the specific section (e.g., "§5 Fitness") in commit messages
2. MUST clauses require full implementation or explicit stub with tracking issue
3. SHOULD clauses are implemented at best effort for MVP
4. Deviations from spec require an ADR

## Code Style

- TypeScript: strict mode, no `any` types without justification
- Rust: standard `cargo fmt` + `cargo clippy`
- No comments that merely narrate code — comments explain *why*, not *what*

## Developer Certificate of Origin (DCO)

All contributions to this project must be **signed off**, certifying
compliance with the [Developer Certificate of Origin v1.1](https://developercertificate.org/).

### How to Sign Off

Sign your commits with the `-s` flag:

```bash
git commit -s -m "your commit message"
```

This automatically appends a `Signed-off-by:` line to the commit message:

```
Signed-off-by: Your Name <your@email.com>
```

If you forgot to sign off and need to amend the last commit:

```bash
git commit --amend -s --no-edit
```

For multiple commits, use rebase with the `--signoff` flag:

```bash
git rebase HEAD~N --signoff   # N = number of commits to sign off
```

### Why DCO

By signing off, you certify that:

1. You wrote the contribution (or have the right to submit it under the
   project's license);
2. You understand the contribution is public and the sign-off is recorded
   permanently in the project's git history;
3. You agree to the [Developer Certificate of Origin v1.1](https://developercertificate.org/) (full text).

### Enforcement

Pull requests with any unsigned commits will be **blocked** by the automated
DCO check (`.github/workflows/dco.yml`). Please sign all commits before
opening a PR.

## License

By contributing, you agree that your contributions will be licensed under Apache-2.0 with the Rotifer Safety Clause. See [LICENSE](LICENSE) for details.
