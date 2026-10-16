# Contributing to nax

Thanks for your interest in contributing to nax! This guide will help you get started.

## Development Setup

> Root scripts (`bun run build|typecheck|lint|check:all|test`) run the matching script in every package. Package commands run from the package directory (`cd packages/nax`). See the [root README](README.md) for the package list.

### Prerequisites

- [Bun](https://bun.sh/) 1.4.3 (the version CI pins)
- Git
- Optional: provider API keys for the opt-in live tests (`packages/nax-ai` `test:live`) and the e2e suite (`packages/nax` `test:e2e`)

### Getting Started

```bash
git clone https://github.com/nathapp-io/nax.git
cd nax
bun install
```

### Running Tests

```bash
# Every package, from the repo root (mocked, no API calls)
bun run test

# One package: its unit and integration suites
cd packages/nax && bun run test:unit
cd packages/nax && bun run test:integration

# One file, from the package directory, with a path and a timeout
cd packages/nax && bun test test/unit/foo.test.ts --timeout=60000

# Type checking and linting, from the repo root
bun run typecheck
bun run lint

# The full gate, as run before a push
bun run check:all
```

Never run a bare `bun test` (with no path) inside a package: it picks up every file in the package, including suites that are not meant to run together.

#### Biome — editor setup

Linting and formatting run on **Biome 2.5.10**, pinned exactly in each package's `devDependencies`.
The v2 config format is not readable by a v1 editor extension, so update your
Biome LSP / editor plugin to a 2.x release. On an older extension you will see
import-ordering and formatting diagnostics that disagree with `bun run lint` —
CI is the source of truth, not your editor.

Two things worth knowing before your first PR:

- `bun run lint` reformats imports. `assist.actions.source.organizeImports` is
  on in the packages' `biome.json`, so `bun run lint:fix` will reorder imports across any file it touches.
- `git blame` skips the tree-wide import reorder via `.git-blame-ignore-revs`.
  Enable it once per clone:

  ```bash
  git config blame.ignoreRevsFile .git-blame-ignore-revs
  ```

### Project Structure

```
packages/
├── nax/             # the nax CLI (Bun bundle, dist/nax.js): src/, bin/, test/, scripts/
├── nax-ai/          # provider-agnostic LLM client (Node ESM): src/, test/
├── nax-agent/       # native coding agent library (Node ESM): src/, test/
├── nax-agent-acp/   # ACP backend and the nax-agent ACP server: src/, test/
├── repo-tooling/    # shared check scripts and the release script (private)
└── test-kit/        # shared bun:test helpers (private)
docs/                # guides, specs and ADRs
```

Most packages keep `test/unit/` and `test/integration/` (or `test/node/`) beside `src/`; `test-kit` has no tests of its own. Keep the layout of the package you change.

## How to Contribute

### Reporting Bugs

- Use the [Bug Report](https://github.com/nathapp-io/nax/issues/new?template=bug_report.md) issue template
- Include your nax version (`nax --version`), OS, and Bun version
- Provide minimal reproduction steps

### Suggesting Features

- Use the [Feature Request](https://github.com/nathapp-io/nax/issues/new?template=feature_request.md) issue template
- Describe the problem you're trying to solve, not just the solution

### Submitting Pull Requests

1. Fork the repo and create your branch from `main`
2. Write tests for any new functionality
3. Ensure the full suite passes: `bun run test`, then `bun run check:all`
4. Run type checking: `bun run typecheck`
5. Run linting: `bun run lint`
6. Use [conventional commits](https://www.conventionalcommits.org/) for your commit messages

### Commit Convention

```
feat: add webhook interaction plugin
fix: prevent stdout double-read in ACP adapter
test: add coverage for regression gate timeout
docs: update CLI reference
chore: bump biome to 2.5.10
```

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Runtime by package** — `packages/nax` is a Bun program and may use Bun APIs (`Bun.file()`, `Bun.spawn()`, etc.). The shipped library code in `packages/nax-ai`, `packages/nax-agent` and `packages/nax-agent-acp` must run on Node and use no Bun API (`check:no-bun-apis` enforces this)
- **File size limit** — `check:file-sizes` fails on source files over 600 lines and test files over 800 lines (existing oversized files are listed in a baseline); split files before they exceed these
- **Injectable dependencies** — use the `_xDeps` pattern for anything that needs mocking in tests (sleep, spawn, etc.)
- **Biome** for formatting and linting — run `bun run lint` before committing

## Testing Conventions

Full rules: **[`docs/guides/testing-rules.md`](docs/guides/testing-rules.md)** — read before writing any test.

Summary:
- Every change needs tests
- Use `describe`/`test`/`expect` from `bun:test`
- Mock external dependencies — tests must never call real APIs or spawn real processes
- No `Bun.sleep()` — use `waitForFile()` or make operations awaitable
- No `Bun.spawn` for shell utilities — use `node:fs/promises` directly
- No flaky tests — fix the design, not the timeout
- `mock.restore()` in every `afterEach`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
