---
priority: 30
appliesTo:
  - "src/**/*.ts"
  - "bin/**/*.ts"
stages:
  - "context"
  - "execution"
  - "tdd-test-writer"
  - "tdd-implementer"
  - "tdd-verifier"
  - "verify"
  - "rectify"
  - "review"
  - "review-semantic"
  - "review-adversarial"
  - "autofix"
  - "single-session"
  - "tdd-simple"
  - "no-test"
  - "batch"
  - "review-dialogue"
  - "debate"
  - "queue-check"
  - "routing"
  - "constitution"
  - "prompt"
  - "optimizer"
---

# Project Conventions

> Concise directives. For detailed rationale, see `docs/architecture/conventions.md` §1–§4 and `docs/architecture/coding-standards.md` §9–§10.

## Language & Runtime

- **Bun-native only.** Use `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.sleep()`. Never use Node.js equivalents (`fs.readFile`, `child_process.spawn`, `setTimeout` for delays).
- TypeScript strict mode. No `any` unless unavoidable (document why).
- Target: Bun 1.3.7+.

## Polyglot / Monorepo Awareness

nax is itself TypeScript-on-Bun, but it **orchestrates polyglot monorepos** (TS, Go, Python, Rust, polyglot). Any code that classifies test files, derives test-file paths, detects frameworks, or scans the filesystem must be language-agnostic and package-scope-aware. See [monorepo-awareness.md](./monorepo-awareness.md) for the full ruleset — this is as important as the Bun-native rule above.

Quick rules of thumb:
- Use `packageDir` (not `workdir`) for anything scoped to one package.
- `process.cwd()` is banned outside CLI entry points.
- Test-file classification: `resolveTestFilePatterns()` — never inline regex.
- Test commands, globs, extensions: config-driven, not hardcoded.

## File Size

- **600-line hard limit** for source files; **800-line hard limit** for test files (per `forbidden-patterns.md`).
- If a file approaches its limit, split it before adding more code.
- Split by logical concern (one function/class per file when possible).
- **Enforced** by `bun run check:file-sizes` (part of `bun run lint`). It ratchets against a baseline: existing oversized files are grandfathered but may not grow, and new files must be under the limit. After splitting a grandfathered file, lower the baseline with `bun run check:file-sizes:update`.

## Module Structure

- Every directory with 2+ exports gets a barrel `index.ts`.
- Types go in `types.ts` per module directory.
- Import from barrels (`src/routing`), **never from internal paths** (`src/routing/router`). This prevents singleton fragmentation in Bun's module registry.

### Path Aliases

Two path aliases are wired in `tsconfig.json`:

| Alias | Resolves To | Use For |
|:---|:---|:---|
| `@/*` | `./src/*` | Source code imports across `src/`, `bin/`, and `test/` |
| `@test/*` | `./test/*` | Cross-tree imports inside `test/` (helpers, fixtures) |

Same barrel rule applies — value imports must hit barrels:

```typescript
// Correct
import { Router } from "@/routing";
import { makeMockAgentManager } from "@test/helpers";

// Correct — type-only imports may hit leaf paths (e.g. selectors per
// config-patterns.md), since TypeScript erases them at compile time.
import type { RoutingConfig } from "@/config/selectors";

// Wrong — value import bypasses the barrel; fragments singletons.
import { Router } from "@/routing/router";
```

Aliases are not mandatory — relative paths are still fine. Use the alias when it improves readability (typically 3+ levels of `../`). Enforced by `bun run check:alias-internals` (runs as part of `bun run lint`).

**Migration ratchet:** `bun run check:deep-relatives` (also part of `lint`) tracks all 2+ level relative imports against a saved baseline. The count must not increase — new code must use aliases. When you touch a file, convert its deep relatives as you go. When the baseline reaches 0, delete it. To lower the baseline after migrating a batch: `bun run check:deep-relatives:update`.

## Logging

- Use the project logger (`src/logger`). Never use `console.log` / `console.error` in source code.
- Log format: no emojis. Use `[OK]`, `[WARN]`, `[FAIL]`, `->`. Machine-parseable.

### Structured Log Fields — Mandatory

Every `logger.info/debug/warn/error` call inside a pipeline stage **must** include `storyId` in its data object.

```typescript
// Correct
logger.info("acceptance", "Running acceptance tests", { storyId: ctx.story.id });
logger.warn("verify", "No test command configured", { storyId: ctx.story.id });

// Wrong — missing storyId (breaks parallel log correlation)
logger.info("acceptance", "Running acceptance tests");
logger.warn("verify", "No test command configured", { command });
```

**Why:** In parallel mode, multiple stories emit log entries to the same JSONL file concurrently. Without `storyId` on every line, it is impossible to attribute a log entry to a specific story.

**Rule:** `storyId` must be the **first key** in the data object. Other fields follow after it.

```typescript
// storyId first
logger.error("acceptance", "Tests failed", { storyId: ctx.story.id, failedACs, packageDir });

// storyId buried
logger.error("acceptance", "Tests failed", { failedACs, packageDir, storyId: ctx.story.id });
```

**Scope:** Applies to `src/pipeline/stages/` and `src/review/`. Utility modules (`src/quality/runner.ts`, `src/verification/`) use `storyId` when it is passed in via options — no requirement to thread it independently.

## Prompt Building

- **All LLM prompt-building logic lives in `src/prompts/builders/`.** Never write `build*Prompt` functions in pipeline stages, verification, execution, review, or any other subsystem directory.
- Import from the barrel (`src/prompts`), never from internal paths (`src/prompts/builders/rectifier-builder`).
- See `forbidden-patterns.md` → **Prompt Builder Convention** for the full builder registry and examples.

## Runtime Layering

- One `NaxRuntime` per run — construct via `createRuntime(config, workdir)`. No bare `new AgentManager(...)` outside `src/runtime/internal/`.
- `AgentManager` and `SessionManager` are pure peers; integration lives at `callOp` / `buildHopCallback` in `src/operations/`.
- New Operations: `src/operations/<name>.ts`, exported from the barrel.
- See `adapter-wiring.md` for entry-point selection; `docs/architecture/subsystems.md` §34–§37 for the why.

## Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Atomic — one logical change per commit.
- Never include `[run-release]` unless explicitly told to.

## Formatting

- Biome handles formatting and linting. Run `bun run lint` before committing.