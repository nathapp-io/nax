# Project Conventions

> Concise directives. For detailed rationale, see `docs/architecture/conventions.md` §1–§4 and `docs/architecture/coding-standards.md` §9–§10.

## Language & Runtime

- **Bun-native only.** Use `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.sleep()`. Never use Node.js equivalents (`fs.readFile`, `child_process.spawn`, `setTimeout` for delays).
- TypeScript strict mode. No `any` unless unavoidable (document why).
- Target: Bun 1.3.7+.

## File Size

- **400-line hard limit** for all source and test files.
- If a file approaches 400 lines, split it before adding more code.
- Split by logical concern (one function/class per file when possible).

## Module Structure

- Every directory with 2+ exports gets a barrel `index.ts`.
- Types go in `types.ts` per module directory.
- Import from barrels (`src/routing`), **never from internal paths** (`src/routing/router`). This prevents singleton fragmentation in Bun's module registry.

## Logging

- Use the project logger (`src/logger`). Never use `console.log` / `console.error` in source code.
- Log format: no emojis. Use `[OK]`, `[WARN]`, `[FAIL]`, `->`. Machine-parseable.

### Structured Log Fields — Mandatory

Every `logger.info/debug/warn/error` call inside a pipeline stage **must** include `storyId` in its data object.

```typescript
// ✅ Correct
logger.info("acceptance", "Running acceptance tests", { storyId: ctx.story.id });
logger.warn("verify", "No test command configured", { storyId: ctx.story.id });

// ❌ Wrong — missing storyId (breaks parallel log correlation)
logger.info("acceptance", "Running acceptance tests");
logger.warn("verify", "No test command configured", { command });
```

**Why:** In parallel mode, multiple stories emit log entries to the same JSONL file concurrently. Without `storyId` on every line, it is impossible to attribute a log entry to a specific story.

**Rule:** `storyId` must be the **first key** in the data object. Other fields follow after it.

```typescript
// ✅ storyId first
logger.error("acceptance", "Tests failed", { storyId: ctx.story.id, failedACs, packageDir });

// ❌ storyId buried
logger.error("acceptance", "Tests failed", { failedACs, packageDir, storyId: ctx.story.id });
```

**Scope:** Applies to `src/pipeline/stages/` and `src/review/`. Utility modules (`src/quality/runner.ts`, `src/verification/`) use `storyId` when it is passed in via options — no requirement to thread it independently.

## Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Atomic — one logical change per commit.
- Never include `[run-release]` unless explicitly told to.

## Formatting

- Biome handles formatting and linting. Run `bun run lint` before committing.
