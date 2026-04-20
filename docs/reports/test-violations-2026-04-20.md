# Test Folder Violations Report

**Date:** 2026-04-20  
**Branch:** fix/test-violations  
**Audit scope:** `test/` against `.claude/rules/forbidden-patterns.md`, `test-architecture.md`, `test-writing.md`  
**Baseline:** Full suite green on `main`

---

## CRITICAL — File/Directory Structure

### Rule: No documentation files in `test/` (test-architecture.md §3)

| File | Violation | Resolution |
|------|-----------|------------|
| `test/COVERAGE-GAPS.md` | Doc file at `test/` root | Moved to `docs/reports/` |
| `test/integration/US-002-TEST-SUMMARY.md` | Summary doc inside `test/` | Moved to `docs/reports/` |
| `test/integration/US-003-TEST-SUMMARY.md` | Same | Moved to `docs/reports/` |
| `test/integration/US-004-TEST-SUMMARY.md` | Same | Moved to `docs/reports/` |
| `test/integration/US-005-TEST-SUMMARY.md` | Same | Moved to `docs/reports/` |
| `test/integration/US-007-TEST-SUMMARY.md` | Same | Moved to `docs/reports/` |

### Rule: No standalone bug-fix test files (test-architecture.md §2)

| File | Violation | Resolution |
|------|-----------|------------|
| `test/integration/routing/routing-stage-bug-021.test.ts` | Named by bug number | Tests merged into `routing-stage-greenfield.test.ts` |

### Rule: No unrecognized test categories (test-architecture.md — unit/integration/ui only)

| Directory | Violation | Resolution |
|-----------|-----------|------------|
| `test/manual/` | Not a defined category | `logging-formatter-demo.ts` moved to `test/integration/plan/` |

### Rule: Clean up temp files in afterAll() (test-architecture.md)

| Path | Violation | Resolution |
|------|-----------|------------|
| `test/tmp/headless-test/test.jsonl` | Persistent leftover — not cleaned by `afterAll()` | File deleted; `.gitkeep` retained |
| `test/integration/tmp/headless-test/test.jsonl` | Same | File deleted |

---

## HIGH — 400-Line Hard Limit

All source and test files must stay under 400 lines (project-conventions.md). Files split by describe block into `<module>-<concern>.test.ts`.

| Original File | Lines | Split Into |
|---------------|-------|-----------|
| `test/unit/context/context.test.ts` | 1889 | `context-builder.test.ts`, `context-providers.test.ts`, `context-cross-package.test.ts`, `context-session.test.ts` |
| `test/integration/cli/cli-precheck.test.ts` | 1877 | `cli-precheck-git.test.ts`, `cli-precheck-config.test.ts`, `cli-precheck-story.test.ts`, `cli-precheck-permissions.test.ts` |
| `test/integration/cli/cli-core.test.ts` | 1573 | `cli-core-run.test.ts`, `cli-core-logs.test.ts`, `cli-core-diagnose.test.ts` |
| `test/integration/cli/cli-config.test.ts` | 1392 | `cli-config-read.test.ts`, `cli-config-write.test.ts`, `cli-config-merge.test.ts` |
| `test/unit/pipeline/stages/acceptance-setup.test.ts` | 1187 | `acceptance-setup-generation.test.ts`, `acceptance-setup-refinement.test.ts`, `acceptance-setup-paths.test.ts` |
| `test/unit/review/semantic.test.ts` | 1047 | `semantic-checks.test.ts`, `semantic-scoring.test.ts`, `semantic-filtering.test.ts` |
| `test/integration/execution/parallel-batch.test.ts` | 1014 | `parallel-batch-core.test.ts`, `parallel-batch-metrics.test.ts` |
| `test/unit/pipeline/stages/autofix.test.ts` | 988 | `autofix-core.test.ts`, `autofix-retry.test.ts`, `autofix-prompt.test.ts` |
| `test/unit/execution/unified-executor.test.ts` | 937 | `unified-executor-core.test.ts`, `unified-executor-escalation.test.ts` |
| `test/unit/debate/session.test.ts` | 932 | `session-core.test.ts`, `session-rounds.test.ts`, `session-verdict.test.ts` |
| `test/integration/agents/acp/tdd-flow.test.ts` | 888 | `tdd-flow-setup.test.ts`, `tdd-flow-execution.test.ts` |
| `test/unit/acceptance/generator-prd.test.ts` | 884 | `generator-prd-basic.test.ts`, `generator-prd-backup.test.ts` |
| `test/integration/pipeline/reporter-lifecycle.test.ts` | 860 | `reporter-lifecycle-events.test.ts`, `reporter-lifecycle-hooks.test.ts` |
| `test/unit/precheck/precheck-checks.test.ts` | 850 | `precheck-checks-git.test.ts`, `precheck-checks-config.test.ts` |
| `test/unit/acceptance/fix-executor.test.ts` | 838 | `fix-executor-core.test.ts`, `fix-executor-prompt.test.ts` |
| `test/unit/review/adversarial.test.ts` | 831 | `adversarial-core.test.ts`, `adversarial-scoring.test.ts` |
| `test/unit/cli/plan-decompose.test.ts` | 811 | `plan-decompose-core.test.ts`, `plan-decompose-routing.test.ts` |
| `test/integration/plan/logger.test.ts` | 460 | `logger-output.test.ts`, `logger-format.test.ts` |

---

## MEDIUM — Bun-native API Violations

### `readFileSync` / `writeFileSync` → `Bun.file().text()` / `Bun.write()` (forbidden-patterns.md)

Note: `mkdtempSync` and `mkdirSync` remain permitted per test-architecture.md (fixture setup only).

| File | Node.js API used | Replaced with |
|------|-----------------|---------------|
| `test/unit/execution/pid-registry-race.test.ts` | `readFileSync` | `Bun.file().text()` |
| `test/unit/agents/phase5-invariants.test.ts` | `readFileSync` | `Bun.file().text()` |
| `test/unit/agents/session-fields-invariants.test.ts` | `readdirSync`, `readFileSync` | `Bun.readdir()`, `Bun.file().text()` |
| `test/unit/agents/adapter-cleanup.test.ts` | `readFileSync` | `Bun.file().text()` |
| `test/unit/config/loader-startdir.test.ts` | `writeFileSync` | `Bun.write()` |
| `test/unit/config/legacy-agent-keys.test.ts` | `writeFileSync` | `Bun.write()` |
| `test/unit/config/smart-runner-flag.test.ts` | `writeFileSync` | `Bun.write()` |
| `test/unit/execution/lifecycle/acceptance-loop.test.ts` | `writeFileSync` ×7 | `Bun.write()` |
| `test/unit/acceptance/generator-prd.test.ts` | `readFileSync`, `writeFileSync` | `Bun.file().text()`, `Bun.write()` |
| `test/integration/execution/deferred-review-integration.test.ts` | `writeFileSync` | `Bun.write()` |
| `test/integration/execution/status-writer.test.ts` | `readFileSync` ×8 | `Bun.file().text()` |

### `await new Promise(r => setTimeout(r, N))` → `await Bun.sleep(N)` (project-conventions.md)

> `setTimeout` with `clearTimeout`/`AbortController` is the permitted exception (cancellable timers).

| File | Line | Resolution |
|------|------|-----------|
| `test/unit/execution/structured-failure.test.ts` | 401 | `await Bun.sleep(10)` |
| `test/unit/pipeline/event-bus.test.ts` | 88 | `await Bun.sleep(10)` |
| `test/helpers/fs.ts` | 35 | `await Bun.sleep(pollIntervalMs)` |
| `test/unit/debate/session-plan.test.ts` | 489 | `await Bun.sleep(10)` |
| `test/unit/utils/bun-deps.test.ts` | 65 | `await Bun.sleep(10)` |

---

## Summary

| Severity | Issues Found | Status |
|----------|-------------|--------|
| CRITICAL | 10 | Fixed |
| HIGH | 18 | Fixed |
| MEDIUM | 16 | Fixed |
| **Total** | **44** | **Fixed** |
