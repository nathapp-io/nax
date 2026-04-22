# Phase 2 Skipped Files

## Batch 2 — Pattern B (makeStory)

| File | Reason |
|------|--------|
| `test/unit/metrics/tracker-escalation.test.ts` | `priorErrors`/`priorFailures` fields not on `UserStory` type |
| `test/unit/metrics/tracker-full-suite-gate.test.ts` | `priorErrors`/`priorFailures` fields not on `UserStory` type |
| `test/unit/metrics/tracker-runtime-crashes.test.ts` | `priorErrors`/`priorFailures` fields not on `UserStory` type |
| `test/unit/metrics/tracker.test.ts` | `priorErrors`/`priorFailures` fields not on `UserStory` type |
| `test/unit/pipeline/stages/acceptance-setup-gate.test.ts` | Positional args: `makeStory(id, acceptanceCriteria[])` |
| `test/unit/pipeline/stages/acceptance-setup-criteria.test.ts` | Positional args: `makeStory(id, acceptanceCriteria[])` |
| `test/unit/pipeline/stages/acceptance-setup-commit.test.ts` | Positional args: `makeStory(id, acs[])` |
| `test/unit/pipeline/stages/acceptance-setup-regeneration.test.ts` | Positional args: `makeStory(id, acceptanceCriteria[])` |
| `test/unit/pipeline/stages/acceptance-setup-strategy.test.ts` | Positional args: `makeStory(id, acceptanceCriteria[])` |
| `test/unit/pipeline/stages/completion-semantic.test.ts` | Positional args: `makeStory(id = "US-001")` |
| `test/unit/pipeline/stages/prompt-batch.test.ts` | Positional args: `makeStory(id, title)` |
| `test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts` | Positional args: `makeStory(workdir?)` |
| `test/unit/context/feature-context.test.ts` | Positional args: `makeStory(id: string)` |
| `test/unit/context/feature-resolver.test.ts` | Positional args: `makeStory(id: string)` |
| `test/unit/context/parent-context.test.ts` | Positional args: `makeStory(id, overrides)` |
| `test/unit/cli/plan-decompose-ac13-14.test.ts` | Bespoke `contextFiles` field + complex `routing` in defaults |
| `test/unit/cli/plan-decompose-guards.test.ts` | Bespoke `contextFiles` field + complex `routing` in defaults |
| `test/unit/cli/plan-decompose-adapter.test.ts` | Bespoke `contextFiles` field + complex `routing` in defaults |
| `test/unit/verification/fix-generator.test.ts` | Positional args: `makeStory(id, acs[], status, workdir?)` |
| `test/unit/acceptance/test-path.test.ts` | Positional args: `makeStory(id, workdir?, status)` |
| `test/unit/execution/unified-executor-rl002.test.ts` | Positional args: `makeStory(id, status = "passed")` |
| `test/unit/execution/lifecycle-execution.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/story-context.test.ts` | Positional args: `makeStory(id = "US-001")` |
| `test/unit/execution/runner-completion-skip.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/lifecycle/paused-story-prompts.test.ts` | Positional args: `makeStory(id, overrides)` — `status: "paused"` in defaults |
| `test/unit/execution/lifecycle/run-completion-fallback.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/lifecycle/run-completion-postrun.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/pipeline-result-handler.test.ts` | Positional args: `makeStory(id, overrides)` |
| `test/unit/execution/runner-completion-postrun.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/lifecycle-completion.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/parallel-worker.test.ts` | Bespoke `routing` field in factory defaults |
| `test/unit/execution/unified-executor-rl007.test.ts` | Positional args: `makeStory(id, status = "passed")` |
| `test/unit/prd/prd-get-next-story.test.ts` | Positional args: `makeStory(id, overrides)` |
| `test/unit/prd/prd-regression-failed.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/prd/prd-failure-category.test.ts` | Positional args: `makeStory(id: string)` |
| `test/unit/prd/prd-postrun-reset.test.ts` | Bespoke `priorErrors` field |
| `test/unit/prd/prd-reset-failed.test.ts` | Positional args: `makeStory(id, overrides)` |
| `test/unit/prompts/builders/rectifier-builder.test.ts` | Bespoke `makeStory` returning narrow partial type |
| `test/unit/routing/strategies/keyword.test.ts` | 9 call sites, complex routing overrides |
| `test/unit/routing/strategies/llm-adapter.test.ts` | Positional args: `makeStory(id = "TEST-001")` |
| `test/unit/tdd/session-runner-tokens.test.ts` | Bespoke `makeStory` returning `as unknown as UserStory` |
| `test/unit/tdd/session-runner-bindhandle.test.ts` | Bespoke `makeStory` returning `as unknown as UserStory` |
| `test/unit/tdd/session-runner-keep-open.test.ts` | Bespoke `makeStory` returning plain object (no escalations/tags/dependencies) |
| `test/unit/tdd/orchestrator-totals.test.ts` | Bespoke `priorFailures` field |
| `test/unit/execution/run-cleanup.test.ts` | Bespoke `makeStory` returning `as unknown as UserStory` |
| `test/unit/execution/parallel-batch.test.ts` | Bespoke `routing` field in factory defaults |
| `test/unit/verification/rectification-loop.test.ts` | Bespoke `makeStory` with `routing: { modelTier: "balanced" }` in defaults |
| `test/unit/verification/rectification-loop-escalation.test.ts` | Bespoke `makeStory` with full `routing` in defaults |
| `test/unit/context/engine/orchestrator-factory.test.ts` | Bespoke defaults (`status: "in-progress", attempts: 1`) |
| `test/unit/acceptance/generator-strategy.test.ts` | No call sites for `makeStory()` (just `makeCriteria`) |
| `test/unit/prd/schema.test.ts` | Schema fuzz test — intentionally constructs invalid `UserStory` |
