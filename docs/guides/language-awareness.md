---
title: Language & Project-Type Awareness
description: Auto-detect project language, type, test framework, and lint tool
---

## Language & Project-Type Awareness

nax auto-detects your project's language, type, test framework, and lint tool from manifest files. This allows nax to adapt its behavior — review commands — without manual configuration.

**Status:** Built-in (v0.54.0) — no plugin or config required.

---

## How Detection Works

On every run, `detectProjectProfile()` inspects your project directory and infers:

| Field | Detected from | Values |
|:------|:--------------|:-------|
| `language` | `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `package.json` (`typescript` dep), `tsconfig.json` | `typescript`, `javascript`, `go`, `rust`, `python` |
| `type` | `package.json` `workspaces`, deps (react/next/vue/nuxt → web, ink → tui, express/fastify/hono → api), `bin` field | `monorepo`, `web`, `api`, `cli`, `tui` |
| `testFramework` | Language + `devDependencies` | `go-test`, `cargo-test`, `pytest`, `vitest`, `jest` |
| `lintTool` | Language + config files (`biome.json`, `.eslintrc*`) | `golangci-lint`, `clippy`, `ruff`, `biome`, `eslint` |

Detection order: **Go > Rust > Python > TypeScript > JavaScript**.

---

## Explicit Config Suppresses Auto-Detection

Any field set in `.nax/config.json` `project` is **not** overwritten by auto-detection:

```json
{
  "project": {
    "language": "typescript",
    "type": "api"
  }
}
```

In this example, `testFramework` and `lintTool` are still auto-detected, but `language` and `type` are used as-is.

---

## Per-Language Quality Commands

Explicitly configured commands always win (`quality.commands`, `review.commands`, per-package overrides). When nothing is configured, nax falls back to language-aware defaults in two places:

**Review checks** (`src/review/language-commands.ts`) — used only when the tool's binary is on `PATH`:

| Language | Test | Lint | Typecheck |
|:---------|:-----|:-----|:----------|
| Go | `go test ./...` | `golangci-lint run` | `go vet ./...` |
| Rust | `cargo test` | `cargo clippy -- -D warnings` | — |
| Python | `pytest` | `ruff check .` | `mypy .` |
| TypeScript / JavaScript | `bun run test` | `bun run lint` | `bun run typecheck` |

For TypeScript / JavaScript the `bun run <check>` fallback applies only when `package.json` defines that script.

**Verify gates** (full-suite gate, lint/typecheck checks — `src/quality/command-defaults.ts`) derive conservative defaults from the package manifest, so a package scaffolded mid-run still gets a runnable command:

| Language | Test | Lint | Typecheck |
|:---------|:-----|:-----|:----------|
| Go | `go test ./...` | `go vet ./...` | `go build ./...` |
| Rust | `cargo test` | `cargo clippy` | `cargo check` |
| Python | `pytest` (prefixed `uv run` / `poetry run` when detected) | `ruff check .` only if ruff is configured | `mypy .` only if mypy is configured |
| TypeScript / JavaScript | `<pm> run test` if a `test` script exists, else `bun test` for Bun projects | `biome check .` / `eslint .` only if their config file exists | `<pm> run typecheck`, else `tsc --noEmit` if `tsconfig.json` exists |

`<pm>` is detected from the lockfile (`bun`, `pnpm`, `yarn`, else `npm`).

**Tip:** If your project uses a different command, set it explicitly in `.nax/config.json`:

```json
{
  "quality": {
    "commands": {
      "test": "bun run test",
      "lint": "bun run lint"
    }
  }
}
```

---

## Checking What Was Detected

The run setup logs detected values at the start of each run:

```
[project] Detected: typescript/api (vitest, biome)
[project] Using explicit config: language=go; detected: type=cli, testFramework=go-test, lintTool=golangci-lint
```

Look for these `project` stage lines in the run log (`nax logs`).

---

## Configuration Reference

```json
{
  "project": {
    "language": "typescript",       // optional — auto-detected if omitted
    "type": "api",                   // optional — auto-detected if omitted
    "testFramework": "vitest",       // optional — auto-detected if omitted
    "lintTool": "biome"              // optional — auto-detected if omitted
  },
  "quality": {
    "commands": {}                   // optional — language/manifest defaults used if empty
  }
}
```

All fields under `project` are optional. Omitting a field triggers auto-detection for that field. Explicit `language` also accepts `ruby`, `java`, `kotlin`, and `php`, which are never auto-detected.
