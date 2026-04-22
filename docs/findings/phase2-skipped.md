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

---

## Batch 3 — Pattern A (makeConfig, DEFAULT_CONFIG spreaders)

### DEFAULT_CONFIG spreaders (complex — high call-site count)

| File | Reason |
|------|--------|
| `test/unit/quality/command-resolver.test.ts` | `return { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands: {...} } }` — 14 call sites, each with nested quality.commands spread |
| `test/unit/config/permissions.test.ts` | Factory hardcodes `dangerouslySkipPermissions: false` which differs from `DEFAULT_CONFIG.execution.dangerouslySkipPermissions` (schema default `true`) — behavioral difference |
| `test/unit/agents/manager-swap-loop.test.ts` | `return { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, fallback: { ... } } }` — nested agent.fallback spread, 9 call sites |
| `test/unit/execution/lifecycle-execution.test.ts` | `return { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, regressionGate: {...} }, quality: {...} }` — 10+ call sites, conditional regressionGate mode |
| `test/unit/execution/runner-completion-skip.test.ts` | DEFAULT_CONFIG spreader with regressionGate overrides — 13 call sites |
| `test/unit/execution/story-context.test.ts` | DEFAULT_CONFIG spreader — bespoked `makeStory` signature (positional) also present |

### Sparse casts → Batch 4

| File | Reason |
|------|--------|
| `test/unit/pipeline/verify-smart-runner.test.ts` | `makeContext({ smartTestRunner: true })` — sparse cast via `makeContext` helper, not a local `makeConfig` |
| `test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts` | Sparse `as unknown as NaxConfig` — no DEFAULT_CONFIG spread |
| `test/unit/context/generator.test.ts` | `return {} as unknown as NaxConfig` — empty sparse cast |

### Bespoked signatures → Batch 4

| File | Reason |
|------|--------|
| `test/unit/pipeline/stages/routing-persistence.test.ts` | Bespoke `makeConfig()` signature |
| `test/unit/pipeline/stages/routing-initial-complexity.test.ts` | Bespoke `makeConfig()` signature — `makeStory` already migrated to shared helper |
| `test/unit/pipeline/stages/verify-crash-detection.test.ts` | Bespoke `makeConfig()` + `makeStory()` — both have DEFAULT_CONFIG spread but nested quality/commands overrides |
| `test/unit/pipeline/stages/completion-review-gate.test.ts` | Bespoke `makeConfig(triggers: Record<string, unknown>)` — non-standard signature |
| `test/unit/pipeline/stages/prompt-tdd-simple.test.ts` | Bespoke `makeConfig()` + `makeStory()` — DEFAULT_CONFIG spread but also bespoked signature |
| `test/unit/pipeline/stages/prompt-acceptance.test.ts` | Bespoke `makeConfig()` — sparse cast, bespoked signature |
| `test/unit/pipeline/stages/review-dialogue.test.ts` | Bespoke `makeConfig(dialogueEnabled: boolean, dialogueOverrides?: Record<string, unknown>)` |
| `test/unit/pipeline/stages/review.test.ts` | Bespoke `makeConfig(triggers: Record<string, unknown>)` — non-standard signature |
| `test/unit/context/engine/providers/plugin-loader.test.ts` | Bespoke `makeConfig()` for `ContextPluginProviderConfig` (not `NaxConfig`) |
| `test/unit/context/engine/orchestrator-factory.test.ts` | Bespoke `makeConfig()` for `ContextPluginProviderConfig` — both makeConfig and makeStory bespoked |
| `test/unit/agents/manager-complete.test.ts` | Bespoke `makeConfig()` — inline `DEFAULT_CONFIG` references at lines 35/46 NOT inside factory |
| `test/unit/agents/manager-iface-run.test.ts` | Bespoke `makeConfig()` — uses `makeNaxConfig()` internally but has local factory too |
| `test/unit/cli/plan-decompose-ac-repair.test.ts` | Bespoke `makeConfig()` — already uses `makeNaxConfig()` internally at call sites |
| `test/unit/cli/plan-decompose-writeback.test.ts` | Bespoke `makeConfig()` — already uses `makeNaxConfig()` internally at call sites |

### Already migrated (Batch 3 — record for reference)

| File | Reason |
|------|--------|
| `test/unit/worktree/dependencies.test.ts` | `makeConfig(mode, setupCommand?)` → `makeNaxConfig({ execution: { worktreeDependencies: { mode, setupCommand } } })` — migrated ✓ |
| `test/unit/context/feature-context.test.ts` | `makeConfig(enabled, budgetTokens?)` → `makeNaxConfig({ context: { featureEngine: { enabled, budgetTokens } } })` — migrated ✓ |
| `test/unit/agents/acp/registry.test.ts` | `makeConfig(agentOverrides?)` → `makeNaxConfig({ agent: agentOverrides })` — 19 call sites — migrated ✓ |
| `test/unit/test-runners/resolver.test.ts` | `makeConfig(patterns?)` using `structuredClone(DEFAULT_CONFIG)` → `makeNaxConfig()` — 20 call sites — migrated ✓ |

---

### ContextPluginProviderConfig (not NaxConfig — permanent skip)

| File | Reason |
|------|--------|
| `test/unit/context/engine/providers/plugin-cache.test.ts` | Local factory produces `ContextPluginProviderConfig`, not `NaxConfig` — no migration path |

---

*Files below are Pattern B (makeStory) entries that also have Pattern A (makeConfig) violations. Listed under Batch 2 above; listed here for completeness.*

### Pattern B files also in Pattern A section (see Batch 2 above)

- `test/unit/pipeline/stages/prompt-batch.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/pipeline/stages/completion-semantic.test.ts` — Pattern B: positional args; Pattern A: sparse cast
- `test/unit/execution/lifecycle-execution.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/execution/story-context.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/execution/runner-completion-skip.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/verification/rectification-loop.test.ts` — Pattern B: bespoked makeStory; Pattern A: bespoked makeConfig
- `test/unit/verification/rectification-loop-escalation.test.ts` — Pattern B: bespoked makeStory; Pattern A: bespoked makeConfig
- `test/unit/context/engine/orchestrator-factory.test.ts` — Pattern B: bespoked makeStory; Pattern A: ContextPluginProviderConfig
