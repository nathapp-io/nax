# Fix Plan: nax v0.8 Structured Logging — Phase 2
**Date:** 2026-02-20
**Covers:** AC-6 (runs list/show), AC-7 (per-story metrics), AC-9 (console.log migration)

## Migration Rules
1. Import `getLogger` from `../logger` (adjust path as needed)
2. Get logger instance: `const logger = getLogger()`
3. Replace `console.log(chalk.X(...))` → `logger.info(stage, message, data?)`
4. Replace `console.warn(...)` → `logger.warn(stage, message, data?)`
5. Replace `console.error(...)` → `logger.error(stage, message, data?)`
6. Replace verbose/debug output → `logger.debug(stage, message, data?)`
7. `stage` should be the module/concern: "routing", "context", "agent", "tdd", "pipeline", "config", "cli", etc.
8. Keep chalk formatting in the logger's console formatter — do NOT use chalk in the migrated calls
9. For `data` objects, include structured fields (storyId, cost, duration, etc.) not string interpolation
10. Do NOT change test files — only src/ files

## Phase 2A: Core execution pipeline (highest impact)
**Files:** src/execution/runner.ts, src/execution/helpers.ts, src/execution/post-verify.ts, src/execution/queue-handler.ts
**Commit:** `refactor(execution): migrate console.log to structured logger`

## Phase 2B: Pipeline stages
**Files:** src/pipeline/runner.ts, src/pipeline/events.ts, src/pipeline/stages/*.ts (acceptance, completion, constitution, execution, prompt, review, routing, verification)
**Commit:** `refactor(pipeline): migrate console.log to structured logger`

## Phase 2C: Agents, routing, context, config
**Files:** src/agents/claude.ts, src/agents/cost.ts, src/agents/validation.ts, src/routing/strategies/*.ts, src/context/builder.ts, src/config/loader.ts, src/analyze/*.ts
**Commit:** `refactor(agents): migrate console.log to structured logger`

## Phase 2D: CLI, TDD, hooks, metrics + runs list/show commands
**Files:** src/cli/*.ts, src/tdd/*.ts, src/hooks/*.ts, src/metrics/*.ts, src/review/*.ts, src/acceptance/*.ts
**Also:** Implement `nax runs list -f <feature>` and `nax runs show <run-id> -f <feature>` commands in bin/nax.ts
**Also:** Add per-story metrics summary table to run.complete event
**Commit:** `feat(cli): add nax runs commands and migrate remaining console.log`

## Verification
After all phases: `grep -rn "console\.\(log\|warn\|error\)" src/ | grep -v "logger\.ts\|formatters\.ts" | wc -l` should be 0
Run: `bun test` — all tests must pass
