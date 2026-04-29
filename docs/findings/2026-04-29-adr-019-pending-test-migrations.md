# ADR-019 Pending Test Migrations

**Date:** 2026-04-29
**Branch:** `refactor/adr-019-source-cleanup` (pending)
**Context:** After applying `scripts/adr-019-source-cleanup.patch`, 44 test files fail with `DISPATCH_NO_RUNTIME`. The original playbook identified 7 files, but the actual scope is much larger.

## Already Migrated (3 files)

These files have been migrated and pass with the cleanup patch applied:

- [x] `test/unit/review/adversarial-pass-fail.test.ts` — 19 pass, 0 fail
- [x] `test/unit/review/semantic-findings.test.ts` — 13 pass, 0 fail
- [x] `test/unit/review/semantic-agent-session.test.ts` — 20 pass, 0 fail

## Pending Migrations (44 files)

When the source-cleanup patch is applied, these 44 files exhibit `DISPATCH_NO_RUNTIME` errors. They need either:
- **T2-review**: Direct calls to `runSemanticReview()` / `runAdversarialReview()` need a `runtime` parameter
- **T2-pipeline**: Pipeline stage tests with `makeCtx()` helpers need `runtime` derived from `agentManager`
- **T3-specialized**: Complex test files with custom mocking patterns that need individual analysis

### Review tests (11 files)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/review/semantic-debate.test.ts` | T2-review | 9 | AC3 test checks `agent.run()` call count |
| `test/unit/review/semantic-prompt-response.test.ts` | T2-review | ~8 | LLM prompt construction assertions |
| `test/unit/review/semantic-retry.test.ts` | T2-review | ~8 | JSON retry success/failure paths |
| `test/unit/review/semantic-retry-truncation.test.ts` | T2-review | ~5 | Truncation-detected condensed retry |
| `test/unit/review/semantic-threshold.test.ts` | T2-review | ~8 | blockingThreshold behavior |
| `test/unit/review/semantic-unverifiable.test.ts` | T2-review | ~7 | Unverifiable finding handling |
| `test/unit/review/semantic-signature-diff.test.ts` | T2-review | ~13 | Diff signature tests |
| `test/unit/review/adversarial-retry.test.ts` | T2-review | ~8 | JSON retry + session close |
| `test/unit/review/adversarial-threshold.test.ts` | T2-review | ~8 | blockingThreshold behavior |
| `test/unit/review/adversarial-metadata-audit.test.ts` | T2-review | ~8 | Audit gate + metadata |

### Pipeline stage tests (12 files)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/pipeline/stages/autofix-adversarial.test.ts` | T2-pipeline | 46 | `runTestWriterRectification` tests |
| `test/unit/pipeline/stages/autofix-budget-prompts.test.ts` | T2-pipeline | 8 | Budget prompt tests |
| `test/unit/pipeline/stages/autofix-dialogue.test.ts` | T2-pipeline | ~10 | Dialogue/autofix integration |
| `test/unit/pipeline/stages/autofix-noop.test.ts` | T2-pipeline | ~8 | No-op short-circuit |
| `test/unit/pipeline/stages/autofix-session-wiring.test.ts` | T2-pipeline | ~8 | Session wiring tests |
| `test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts` | T2-pipeline | ~8 | Agent swap metrics |
| `test/unit/pipeline/stages/execution-ambiguity.test.ts` | T2-pipeline | ~8 | Ambiguity handling |
| `test/unit/pipeline/stages/execution-merge-conflict.test.ts` | T2-pipeline | ~8 | Merge conflict resolution |
| `test/unit/pipeline/stages/execution-tdd-simple.test.ts` | T2-pipeline | ~8 | TDD execution |
| `test/unit/pipeline/stages/review.test.ts` | T2-pipeline | ~8 | Review stage integration |
| `test/unit/pipeline/stages/verify-crash-detection.test.ts` | T2-pipeline | ~8 | Crash detection |
| `test/unit/pipeline/verify-smart-runner.test.ts` | T2-pipeline | ~8 | Smart runner |

### Execution & lifecycle tests (8 files)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/execution/crash-recovery.test.ts` | T3-specialized | ~8 | Crash recovery may need runtime injection |
| `test/unit/execution/crash-signals-idempotency.test.ts` | T3-specialized | ~8 | Signal handling |
| `test/unit/execution/lifecycle-completion.test.ts` | T3-specialized | ~8 | Lifecycle completion |
| `test/unit/execution/lifecycle-execution.test.ts` | T3-specialized | ~8 | Lifecycle execution |
| `test/unit/execution/lifecycle/acceptance-fix.test.ts` | T3-specialized | ~8 | Acceptance fix |
| `test/unit/execution/lifecycle/acceptance-loop.test.ts` | T3-specialized | ~8 | Acceptance loop |
| `test/unit/execution/pipeline-result-handler.test.ts` | T3-specialized | ~8 | Result handler |
| `test/unit/execution/story-selector.test.ts` | T3-specialized | ~8 | Story selector |

### Verification tests (2 files)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/verification/rectification-loop.test.ts` | T2-pipeline | ~8 | Rectification loop |
| `test/unit/verification/rectification-loop-escalation.test.ts` | T2-pipeline | ~8 | Escalation |

### CLI tests (6 files)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/cli/init.test.ts` | T3-specialized | ~8 | CLI init |
| `test/unit/cli/init-detect.test.ts` | T3-specialized | ~8 | Init detection |
| `test/unit/cli/init-detect-ui.test.ts` | T3-specialized | ~8 | UI detection |
| `test/unit/cli/plan-replan.test.ts` | T3-specialized | ~8 | Plan/replan |
| `test/unit/cli/prompts-init.test.ts` | T3-specialized | ~8 | Prompts init |
| `test/unit/cli/rules.test.ts` | T3-specialized | ~8 | Rules |

### Context & plugins (5 files)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/context/engine/orchestrator-extra-provider-ids.test.ts` | T3-specialized | ~8 | Extra providers |
| `test/unit/context/engine/orchestrator-unknown-providers.test.ts` | T3-specialized | ~8 | Unknown providers |
| `test/unit/plugins/plugin-logger.test.ts` | T3-specialized | ~8 | Plugin logger |
| `test/unit/plugins/registry.test.ts` | T3-specialized | ~8 | Plugin registry |
| `test/unit/commands/logs.test.ts` | T3-specialized | ~8 | Logs command |

### Runtime tests (1 file)

| File | Pattern | Est. Tests | Notes |
|------|---------|------------|-------|
| `test/unit/runtime/middleware/logging.test.ts` | T3-specialized | ~8 | Middleware logging |

## Migration patterns

### Pattern T2-review (direct review-function calls)

For tests calling `runSemanticReview()` or `runAdversarialReview()` directly:

```typescript
// Before:
const result = await runSemanticReview(
  workdir, storyGitRef, story, config, agentManager
);

// After:
const agentManager = makeAgentManager(response);
const runtime = makeMockRuntime({ agentManager });
const result = await runSemanticReview(
  workdir, storyGitRef, story, config, agentManager,
  undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, runtime, // 15th arg
);
```

### Pattern T2-pipeline (pipeline stage tests with makeCtx())

For tests with a `makeCtx()` helper:

```typescript
function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const agentManager = overrides.agentManager ?? makeMockAgentManager();
  return {
    // ...existing fields...
    agentManager,
    runtime: overrides.runtime ?? makeMockRuntime({ agentManager }),
    ...overrides,
  };
}
```

### Pattern T3-specialized (custom mocking)

Some test files have custom mocking patterns that don't fit T2-review or T2-pipeline:
- Tests that mock `runTestWriterRectification` or `runAgentRectification` directly
- Tests that assert on `agent.run()` call count/options (ADR-019 uses `runWithFallback`)
- Tests with deeply nested mock setups

These require individual analysis. Common adjustments:
1. Change `agentManager.run` assertions to `agentManager.runWithFallback`
2. Access `runOptions` via `request.runOptions` from `runWithFallback.mock.calls[0][0]`
3. Remove `keepOpen` assertions (not used in runtime path)
4. For rectification tests, ensure `ctx.runtime` is set in the test context

## Known migration blockers

### Blocker 1: Tests asserting on `agent.run()` vs `runWithFallback()`

The ADR-019 runtime path calls `runWithFallback()` which internally uses `executeHop` → `sessionManager.openSession` → `agentManager.runAsSession`. Tests that check `agentManager.run` call counts need to be updated to check `agentManager.runWithFallback` or use integration-level assertions.

**Files affected:**
- `test/unit/review/semantic-debate.test.ts` (AC3 test)
- `test/unit/review/semantic-retry.test.ts`
- `test/unit/review/adversarial-retry.test.ts`
- `test/unit/pipeline/stages/autofix-adversarial.test.ts`

### Blocker 2: Tests asserting on `keepOpen: true`

The runtime path manages session lifecycle explicitly via `openSession` + `runAsSession` + `closeSession`. The `keepOpen` option is not used.

**Files affected:**
- `test/unit/review/adversarial-retry.test.ts`
- `test/unit/pipeline/stages/autofix-adversarial.test.ts`

### Blocker 3: Tests using custom `makeCtx()` without `runtime` field

Some pipeline stage tests have `makeCtx()` helpers that don't include a `runtime` field. These need to be updated to derive `runtime` from `agentManager`.

**Files affected:**
- All pipeline stage tests listed above
- All execution/lifecycle tests listed above

## Recommended approach

Given the scope (44 files), a single agent session is impractical. Recommended split:

### Wave 1: Review tests (11 files)
Focus on `test/unit/review/*.test.ts`. These are the most straightforward T2-review migrations.

### Wave 2: Pipeline stages (12 files)
Focus on `test/unit/pipeline/stages/*.test.ts`. These are mostly T2-pipeline pattern.

### Wave 3: Execution & lifecycle (8 files)
Focus on `test/unit/execution/**/*.test.ts`. These may need T3-specialized handling.

### Wave 4: CLI, context, plugins, verification (13 files)
Focus on remaining files. These are the most complex and may need custom solutions.

## Verification commands

```bash
# Test one file
timeout 30 bun test <file> --timeout=10000

# Full suite (after all migrations)
bun run test

# Typecheck and lint
bun run typecheck
bun run lint
```

## Source files affected by cleanup patch

When the cleanup patch is applied, these 4 source files have the legacy path removed:

1. `src/review/semantic.ts` — throws `DISPATCH_NO_RUNTIME` if `!runtime`
2. `src/review/adversarial.ts` — throws `DISPATCH_NO_RUNTIME` if `!runtime`
3. `src/pipeline/stages/autofix-agent.ts` — requires `ctx.runtime`
4. `src/pipeline/stages/autofix-adversarial.ts` — requires `ctx.runtime`

## Acceptance criteria for full cleanup

- [ ] All 44 test files migrated or documented as intentionally skipped
- [ ] `bun run test` passes (0 fail)
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] Source-cleanup patch deleted
- [ ] Migration docs deleted
