---
title: Configuration
description: How to configure nax
---

## Configuration

Config is layered — project overrides global:

| File | Scope |
|:-----|:------|
| `~/.nax/config.json` | Global (all projects) |
| `.nax/config.json` | Project-level override |

**Key options:**

```json
{
  "execution": {
    "maxIterations": 20,
    "costLimit": 5.0
  },
  "tdd": {
    "strategy": "auto"
  },
  "routing": {
    "strategy": "keyword"
  },
  "quality": {
    "commands": {
      "test": "bun test test/ --timeout=60000",
      "testScoped": "bun test --timeout=60000 {{files}}",
      "lint": "bun run lint",
      "typecheck": "bun x tsc --noEmit",
      "lintFix": "bun x biome check --fix src/",
      "formatFix": "bun x biome format --write src/"
    }
  }
}
```

### Shell Operators in Commands

Review commands (`lint`, `typecheck`) are executed directly via `Bun.spawn` — **not** through a shell. This means shell operators like `&&`, `||`, `;`, and `|` are passed as literal arguments and will not work as expected.

**❌ This will NOT work:**
```json
"typecheck": "bun run build && bun run typecheck"
```

**✅ Workaround — wrap in a `package.json` script:**
```json
// package.json
"scripts": {
  "build-and-check": "bun run build && bun run typecheck"
}
```
```json
// .nax/config.json
"quality": {
  "commands": {
    "typecheck": "bun run build-and-check"
  }
}
```

This limitation applies to all `quality.commands` entries (`test`, `lint`, `typecheck`, `lintFix`, `formatFix`).

---

### Scoped Test Command

By default, nax runs scoped tests (per-story verification) by appending discovered test files to the `test` command. This can produce incorrect commands when the base command includes a directory path (e.g. `bun test test/`), since the path is not replaced — it is appended alongside it.

Use `testScoped` to define the exact scoped test command with a `{{files}}` placeholder:

| Runner | `test` | `testScoped` |
|:-------|:-------|:-------------|
| Bun | `bun test test/ --timeout=60000` | `bun test --timeout=60000 {{files}}` |
| Jest | `npx jest` | `npx jest -- {{files}}` |
| pytest | `pytest tests/` | `pytest {{files}}` |
| cargo | `cargo test` | `cargo test {{files}}` |
| go | `go test ./...` | `go test {{files}}` |

If `testScoped` is not configured, nax falls back to a heuristic that replaces the last path-like token in the `test` command. **Recommended:** always configure `testScoped` explicitly to avoid surprises.

**TDD strategy options:** <a name="tdd-strategy-options"></a>

| Value | Behaviour |
|:------|:----------|
| `auto` | nax decides based on complexity and tags — simple→`tdd-simple`, security/public-api→`three-session-tdd`, else→`three-session-tdd-lite` |
| `strict` | Always use `three-session-tdd` (strictest — all stories) |
| `lite` | Always use `three-session-tdd-lite` |
| `simple` | Always use `tdd-simple` (1 session) |
| `off` | No TDD — tests written after implementation (`test-after`) |

---

### Routing

Controls how nax classifies story complexity and selects model tier + test strategy.

```json
{
  "routing": {
    "strategy": "keyword"
  }
}
```

**Routing strategy options:** <a name="routing-strategy-options"></a>

| Value | Behaviour |
|:------|:----------|
| `"keyword"` | **Default.** Fast, free, deterministic — classifies by keywords in title/description/tags. No API calls. |
| `"llm"` | Uses the configured LLM to classify complexity. Better accuracy for ambiguous stories. Requires an agent to be configured. |

**Priority order (regardless of strategy):**

1. **PRD explicit** — if a story has `routing.testStrategy` set in `prd.json`, it always wins
2. **Plugin routers** — registered plugins can override routing per-story
3. **Strategy fallback** — keyword or LLM depending on `routing.strategy`

**Opting into LLM routing:**

```json
{
  "routing": {
    "strategy": "llm",
    "llm": {
      "model": "fast",
      "fallbackToKeywords": true,
      "mode": "hybrid"
    }
  }
}
```

> **Note:** LLM routing requires an agent (e.g. `claude`) to be installed and configured. It makes real API calls, which incur cost and latency. For CI or contributor environments, prefer `"keyword"`.

**Per-story override in PRD:**

```json
{
  "userStories": [
    {
      "id": "US-001",
      "routing": {
        "testStrategy": "three-session-tdd",
        "complexity": "complex"
      }
    }
  ]
}
```

Story-level routing always takes priority over `routing.strategy`.

---

### Project Language & Type

Auto-detects your project's language, type, test framework, and lint tool from manifest files. All fields are optional — omit a field to let nax detect it.

```json
{
  "project": {
    "language": "typescript",
    "type": "api",
    "testFramework": "vitest",
    "lintTool": "biome"
  }
}
```

| Field | Auto-detected from | Values |
|:------|:-------------------|:-------|
| `language` | `go.mod`, `Cargo.toml`, `pyproject.toml`, `package.json` | `typescript`, `javascript`, `go`, `rust`, `python` |
| `type` | `package.json` `workspaces`, deps, `bin` field | `monorepo`, `web`, `api`, `cli`, `tui` |
| `testFramework` | Language + dev dependencies | `go-test`, `cargo-test`, `pytest`, `vitest`, `jest` |
| `lintTool` | Language + config files | `golangci-lint`, `clippy`, `ruff`, `biome`, `eslint` |

**Explicit config overrides auto-detection.** Only the fields you set are locked; others are still auto-detected.

See [Language & Project-Type Awareness](language-awareness.md) for full details.

---

### Rectification Escalation

When rectification retries are exhausted at the current model tier, nax can escalate to the next tier for one additional attempt before escalating the story.

```json
{
  "execution": {
    "rectification": {
      "escalateOnExhaustion": true
    }
  }
}
```

| Value | Behaviour |
|:-------|:----------|
| `true` | After `maxRetries` at the current tier, retry once at the next tier (fast→balanced→powerful). Last resort before escalating the story. |
| `false` | Escalate the story immediately after `maxRetries` at current tier. |

**Requires `autoMode.escalation.enabled: true`.**

---

### Build Command

The `build` command is used by the review stage to catch compilation or build errors that typecheck alone might miss.

```json
{
  "quality": {
    "commands": {
      "build": "bun run build"
    }
  }
}
```

Add `"build"` to `review.checks` to include it in the review pipeline:

```json
{
  "review": {
    "checks": ["typecheck", "lint", "build"]
  }
}
```

See [Semantic Review](semantic-review.md) for the behavioral review check.

---

### Monorepo Acceptance Test Exclusion

nax generates per-package acceptance test files at `<package-root>/.nax-acceptance.test.ts`. These files are meant to be run by nax only — **not** by your regular test suite.

**Add to `.gitignore`:**

```
**/.nax-acceptance*
```

**Exclude from jest/vitest per-package config:**

For monorepo projects using jest or vitest, add to each package's test config to prevent `.nax-acceptance.test.ts` from running during `npm test` / `npx turbo test`:

```js
// jest.config.js or vitest.config.ts
testPathIgnorePatterns: [".nax-acceptance"]
// or for vitest:
exclude: ["**/.nax-acceptance*"]
```

**Why this matters:** the acceptance test files import production code with relative paths (e.g. `./src/utils/detect-provider.ts`). They run correctly from their package directory under nax control, but should be excluded from the normal test pipeline to avoid unexpected failures or duplicate runs.

