# Fix Plan: nax v0.8 Structured Logging — Phase 1
**Date:** 2026-02-20
**Branch:** `feat/v0.8-structured-logging`

## Scope
Phase 1: Logger core, CLI flags, JSONL file output, debug mode.
Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-8.
Does NOT touch existing console.log calls (Phase 2).

## Phase 1A: Logger Core
**Commit:** `feat(logger): implement structured Logger with level gating and JSONL output`

### File: `src/logger/index.ts` (NEW)
Export barrel.

### File: `src/logger/logger.ts` (NEW)
- `Logger` class with `error`, `warn`, `info`, `debug` methods
- Each method signature: `(stage: string, message: string, data?: Record<string, unknown>)`
- `withStory(storyId: string)` returns a `StoryLogger` with storyId auto-injected
- Constructor: `{ level: LogLevel, filePath?: string, useChalk?: boolean }`
- Console output: chalk-formatted, filtered by level
- File output: JSON Lines, all levels written regardless of console level
- Singleton pattern: `getLogger()` / `initLogger(opts)`

### File: `src/logger/types.ts` (NEW)
- `LogLevel` type: `"error" | "warn" | "info" | "debug"`
- `LogEntry` interface: `{ timestamp, level, stage, storyId?, message, data? }`
- `LoggerOptions` interface

### File: `src/logger/formatters.ts` (NEW)
- `formatConsole(entry: LogEntry): string` — chalk-formatted human-readable
- `formatJsonl(entry: LogEntry): string` — JSON.stringify one-liner

## Phase 1B: CLI Integration
**Commit:** `feat(cli): add --verbose, --quiet, --silent flags and run directory`

### File: `bin/nax.ts`
- Add `--verbose` flag → sets log level to `debug`
- Add `--quiet` flag → sets log level to `warn`
- Add `--silent` flag → sets log level to `error`
- Add `NAX_LOG_LEVEL` env var support (overrides flags)
- Create run directory: `nax/features/<name>/runs/`
- Generate run ID: ISO timestamp `YYYY-MM-DDTHH-mm-ssZ`
- Pass `filePath` to logger init: `nax/features/<name>/runs/<run-id>.jsonl`
- After run, create/update `latest.jsonl` symlink

### File: `src/config/schema.ts`
- Add `logging` section to NaxConfig: `{ level: LogLevel, verbose: boolean }`

## Phase 1C: Stage Events
**Commit:** `feat(logger): emit structured stage lifecycle events`

### File: `src/execution/runner.ts`
- Add logger calls at key lifecycle points (alongside existing console.log, not replacing):
  - `run.start`, `iteration.start`, `context.built`
  - `agent.start`, `agent.complete`
  - `story.complete`, `run.complete`
- These write to JSONL file even at `info` level

### File: `src/pipeline/stages/routing.ts`
- Add logger call for routing decision

## Phase 1D: Tests
**Commit:** `test(logger): add unit tests for Logger, formatters, and JSONL output`

### Test targets:
- `test/logger.test.ts` — Logger class, level gating, withStory, file output
- `test/formatters.test.ts` — console and JSONL formatters
- Verify: JSONL lines are valid JSON with required fields
- Verify: level gating (debug hidden at info level, etc.)
- Verify: file always gets all levels regardless of console setting

## Test Strategy
- Mode: test-after (implementing against spec)
- Run: `bun test`

## Notes
- Do NOT replace any existing `console.log` calls (Phase 2)
- Logger runs alongside existing output in Phase 1
- Console formatter should closely match current chalk output style
