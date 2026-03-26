---
title: Language & Project-Type Awareness
description: Auto-detect project language, type, test framework, and lint tool
---

## Language & Project-Type Awareness

nax auto-detects your project's language, type, test framework, and lint tool from manifest files. This allows nax to adapt its behavior — review commands, acceptance test generation, TDD conventions, and hermetic test guidance — without manual configuration.

**Status:** Built-in (v0.54.0) — no plugin or config required.

---

## How Detection Works

On every run, `detectProjectProfile()` inspects your project directory and infers:

| Field | Detected from | Values |
|:------|:--------------|:-------|
| `language` | `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `package.json` | `typescript`, `javascript`, `go`, `rust`, `python` |
| `type` | `package.json` `workspaces`, deps, `bin` field | `monorepo`, `web`, `api`, `cli`, `tui` |
| `testFramework` | Language + dev deps | `go-test`, `cargo-test`, `pytest`, `vitest`, `jest` |
| `lintTool` | Language + config files | `golangci-lint`, `clippy`, `ruff`, `biome`, `eslint` |

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

## Per-Language Test Commands

nax uses language-appropriate commands when `quality.commands` is empty (the default):

| Language | Test command | Lint command |
|:---------|:-------------|:-------------|
| TypeScript / JavaScript | `bun test` | `bun run lint` |
| Go | `go test ./...` | `golangci-lint run` |
| Rust | `cargo test` | `cargo clippy` |
| Python | `pytest` | `ruff check .` |

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

## Acceptance Test Filename

Acceptance test filenames follow language conventions:

| Language | Filename |
|:---------|:---------|
| TypeScript / JavaScript | `acceptance.test.ts` |
| Go | `acceptance_test.go` |
| Python | `test_acceptance.py` |
| Rust | `tests/acceptance.rs` |

The file is placed at `.nax/features/<feature>/acceptance.test.<ext>`.

---

## TDD Conventions

The test-writer prompt adapts file naming and placement per language:

| Language | Test file placement | Convention |
|:---------|:-------------------|:----------|
| TypeScript / JavaScript | Adjacent to source | `foo.test.ts` alongside `foo.ts` |
| Go | Same package directory | `foo_test.go` alongside `foo.go` |
| Rust | Inline or `tests/` dir | `#[cfg(test)]` module or `tests/acceptance.rs` |
| Python | `tests/` directory | `tests/test_foo.py` |

---

## Hermetic Test Guidance

When `quality.testing.hermetic: true` (default), nax generates language-specific mocking guidance for the test-writer prompt:

| Language | Mocking patterns suggested |
|:---------|:---------------------------|
| TypeScript | `vi.mock()`, `vi.spyOn()` (Vitest); `jest.mock()`, `jest.spyOn()` (Jest) |
| Go | `gomock`, `testify/mock`, `fakehttp` |
| Rust | `mockall`, `乾` crates |
| Python | `unittest.mock.patch`, `pytest-mock` |

If you set `quality.testing.mockGuidance` explicitly, it overrides auto-detection.

---

## Checking What Was Detected

The run setup logs detected values at the start of each run:

```
[run-setup] Detected: typescript/api (vitest, biome)
[run-setup] Using explicit config: language=go  ← explicit overrides suppress detection
```

Look for these lines in `nax runs` output or the run log.

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
    "commands": {},                  // optional — language defaults used if empty
    "testing": {
      "hermetic": true,              // inject language-aware mocking guidance
      "mockGuidance": "..."          // optional — overrides auto-detection
    }
  }
}
```

All fields under `project` are optional. Omitting a field triggers auto-detection for that field.
