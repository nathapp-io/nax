# Phase 3: Split Files > 400 Lines (MEDIUM priority)

**Branch:** `feat/code-audit` (continue from current HEAD)
**Estimated effort:** 3–5 hours
**Risk:** Medium — must update all import paths, run tests after each split

---

## Rule

ARCHITECTURE.md §1: Hard limit 400 lines per file. Split by responsibility.

---

## Files to Split (sorted by severity)

### 3.1 `src/cli/config.ts` (625 lines) — MOST URGENT
Split into:
- `src/cli/config-display.ts` — display/show logic
- `src/cli/config-set.ts` — set/update logic
- `src/cli/config-get.ts` — get/read logic
- `src/cli/config.ts` — re-exports (hub file)

### 3.2 `src/cli/prompts.ts` (548 lines)
Split by prompt category:
- `src/cli/prompts-init.ts` — initialization prompts
- `src/cli/prompts-config.ts` — configuration prompts
- `src/cli/prompts-run.ts` — run-related prompts
- `src/cli/prompts.ts` — re-exports

### 3.3 `src/agents/claude.ts` (525 lines)
Already uses `_deps` correctly. Split by method group:
- `src/agents/claude-lifecycle.ts` — start/stop/kill methods
- `src/agents/claude-stream.ts` — output streaming/parsing
- `src/agents/claude.ts` — main class + re-exports

### 3.4 `src/execution/parallel-executor.ts` (519 lines)
Split into:
- `src/execution/parallel-worker-init.ts` — worker initialization
- `src/execution/parallel-worker-loop.ts` — worker event loop
- `src/execution/parallel-worker-result.ts` — result collection
- `src/execution/parallel-executor.ts` — coordinator (hub)

### 3.5 `src/config/types.ts` (491 lines)
Split into:
- `src/config/schema-types.ts` — JSON schema types
- `src/config/runtime-types.ts` — runtime config types
- `src/config/types.ts` — re-exports

### 3.6 `src/commands/logs.ts` (454 lines)
Split into:
- `src/commands/logs-reader.ts` — log reading/parsing
- `src/commands/logs-formatter.ts` — log formatting/display
- `src/commands/logs.ts` — command entry point

### 3.7 `src/precheck/checks-blockers.ts` (427 lines)
Split by check category (git checks, env checks, config checks).

### 3.8 `src/execution/crash-recovery.ts` (419 lines)
Split into:
- `src/execution/crash-writer.ts` — crash data serialization
- `src/execution/crash-reader.ts` — crash data deserialization
- `src/execution/crash-detection.ts` — crash detection logic
- `src/execution/crash-recovery.ts` — orchestrator (hub)

### 3.9 `src/tdd/verdict.ts` (417 lines)
Split into:
- `src/tdd/verdict-parser.ts` — parse raw output
- `src/tdd/verdict-coerce.ts` — coerce to standard format
- `src/tdd/verdict.ts` — validate + re-exports

### 3.10 `src/execution/parallel.ts` (412 lines)
Split into coordinator + worker modules.

### 3.11 `src/plugins/types.ts` (409 lines)
Split into plugin types + extension types.

### 3.12 `src/execution/runner.ts` (401 lines)
Borderline. Only split if it grows further. Skip for now.

---

## Process for Each Split

1. Create new files with extracted logic
2. Update the original file to re-export from new files (maintain backward compatibility)
3. Update all import paths that directly imported from the original
4. Run `bun run typecheck`
5. Run `bun test --bail`
6. Commit each split individually: `refactor(cli): split config.ts into display/set/get modules`

---

## Completion Checklist

- [ ] All files under 400 lines (except runner.ts at 401 — borderline)
- [ ] All import paths updated
- [ ] `bun run typecheck` — zero errors
- [ ] `bun run lint` — zero errors
- [ ] `bun test` — no regressions
- [ ] Do NOT push to remote
