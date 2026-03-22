# Contributing to nax

Thanks for your interest in contributing to nax! This guide will help you get started.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) v1.3.7 or later
- Git
- An Anthropic API key (for running real agent tests)

### Getting Started

```bash
git clone https://github.com/nathapp-io/nax.git
cd nax
bun install
```

### Running Tests

```bash
# Full test suite (mocked — no API calls)
bun test

# Specific test file
bun test test/unit/foo.test.ts

# Unit tests only
bun run test:unit

# Integration tests only
bun run test:integration

# Type checking
bun run typecheck

# Linting
bun run lint
```

### Project Structure

```
src/
├── agents/          # Agent adapters (Claude CLI, ACP)
├── analyze/         # Story analysis and complexity scoring
├── config/          # Configuration loading and validation
├── execution/       # Sequential executor, session runner
├── interaction/     # Human-in-the-loop plugins (Telegram, webhook)
├── precheck/        # Pre-run validation checks
├── routing/         # Model tier routing strategies
├── tui/             # Terminal UI (Ink-based)
└── verification/    # Test verification, regression gate
test/
├── unit/            # Unit tests (fast, mocked)
├── integration/     # Integration tests (file system, processes)
└── helpers/         # Shared test utilities
```

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
3. Ensure the full test suite passes: `bun test`
4. Run type checking: `bun run typecheck`
5. Run linting: `bun run lint`
6. Use [conventional commits](https://www.conventionalcommits.org/) for your commit messages

### Commit Convention

```
feat: add webhook interaction plugin
fix: prevent stdout double-read in ACP adapter
test: add coverage for regression gate timeout
docs: update CLI reference
chore: bump biome to v1.9
```

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Bun-native** — use Bun APIs (`Bun.file()`, `Bun.spawn()`, etc.), not Node.js equivalents
- **400-line file limit** — split files before they exceed this
- **Injectable dependencies** — use the `_xDeps` pattern for anything that needs mocking in tests (sleep, spawn, etc.)
- **Biome** for formatting and linting — run `bun run lint` before committing

## Testing Conventions

- Every change needs tests
- Use `describe`/`test`/`expect` from `bun:test`
- Mock external dependencies — tests should never call real APIs
- No `Bun.sleep()` in tests — use injectable `_deps.sleep` pattern
- No flaky tests — if a test is timing-sensitive, fix the design

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
