# Phase 2 Skipped Files

## Pattern A — Permanent Skips (makeConfig / DEFAULT_CONFIG spreaders)

### Legacy config keys — causes CONFIG_LEGACY_AGENT_KEYS error

| File | Reason |
|------|--------|
| `test/unit/pipeline/verify-smart-runner.test.ts` | Uses `autoMode.defaultAgent` / `autoMode.fallbackOrder` — legacy keys removed from schema; `makeContext` helper uses sparse cast, not local factory |

### Behavioral differences — cannot migrate without changing test semantics

| File | Reason |
|------|--------|
| `test/unit/config/permissions.test.ts` | Factory hardcodes `dangerouslySkipPermissions: false` which differs from schema default `true` (DEFAULT_CONFIG.execution.dangerouslySkipPermissions) — behavioral difference; reverted in Batch 3 |

### Inline DEFAULT_CONFIG outside factory — requires separate third pass

| File | Reason |
|------|--------|
| `test/unit/agents/manager-complete.test.ts` | Inline `DEFAULT_CONFIG` references at lines 51/62/70/72/86 OUTSIDE the local `makeConfig()` factory — passed directly to `completeWithFallback()` |

### Bespoked makeStory (Batch 2 concern) — Pattern A issues deferred

| File | Reason |
|------|--------|
| `test/unit/pipeline/stages/verify-crash-detection.test.ts` | Bespoked `makeStory` (status: "in-progress", attempts: 1) — Batch 2; `makeConfig` also bespoked (DEFAULT_CONFIG spread with quality/commands overrides) but file cannot be fully resolved until Batch 2 |
| `test/unit/pipeline/stages/completion-review-gate.test.ts` | Bespoked `makeConfig(triggers: Record<string, unknown>)` + bespoked `makeStory` — non-standard factory signature; Pattern B deferred |
| `test/unit/pipeline/stages/prompt-tdd-simple.test.ts` | Bespoked `makeConfig()` + `makeStory()` — DEFAULT_CONFIG spread but bespoked signature; Pattern B deferred |

### Complex DEFAULT_CONFIG spreaders — too many call sites to migrate safely

| File | Reason |
|------|--------|
| `test/unit/quality/command-resolver.test.ts` | 14 call sites; each spreads `DEFAULT_CONFIG.quality.commands` with nested structure — would require deep per-call-site analysis |
| `test/unit/execution/lifecycle-execution.test.ts` | 10+ call sites; nested `DEFAULT_CONFIG.execution.regressionGate` + `DEFAULT_CONFIG.quality` spread with conditional regressionGate mode |
| `test/unit/execution/runner-completion-skip.test.ts` | 13 call sites; DEFAULT_CONFIG spreader with regressionGate overrides |
| `test/unit/agents/manager-swap-loop.test.ts` | 9 call sites; nested `DEFAULT_CONFIG.agent.fallback` spread with deep object merge |

### ContextPluginProviderConfig — not NaxConfig, no migration path

| File | Reason |
|------|--------|
| `test/unit/context/engine/providers/plugin-loader.test.ts` | Factory produces `ContextPluginProviderConfig`, not `NaxConfig` — no shared helper covers this type |
| `test/unit/context/engine/orchestrator-factory.test.ts` | Bespoked `makeConfig()` for `ContextPluginProviderConfig` — also has bespoked `makeStory` (Batch 2); no NaxConfig migration path |
| `test/unit/context/generator.test.ts` | `return {} as unknown as NaxConfig` — empty sparse cast to wrong type; not a `makeConfig` factory issue |
| `test/unit/context/engine/providers/plugin-cache.test.ts` | Local factory produces `ContextPluginProviderConfig`, not `NaxConfig` — no migration path |

---

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
| `test/unit/execution/run-completion-fallback.test.ts` | Positional args: `makeStory(id, status)` |
| `test/unit/execution/run-completion-postrun.test.ts` | Positional args: `makeStory(id, status)` |
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
| `test/unit/cli/plan-replan.test.ts` | Bespoke `contextFiles` field + complex `routing` in defaults |
| `test/unit/cli/plan-decompose-regression.test.ts` | Bespoke `contextFiles` field + complex `routing` in defaults |

---

## Pattern A — Already Migrated

### Batch 3 (PR #642 — merged)

| File | Reason |
|------|--------|
| `test/unit/worktree/dependencies.test.ts` | `makeConfig(mode, setupCommand?)` → `makeNaxConfig({ execution: { worktreeDependencies: { mode, setupCommand } } })` |
| `test/unit/context/feature-context.test.ts` | `makeConfig(enabled, budgetTokens?)` → `makeNaxConfig({ context: { featureEngine: { enabled, budgetTokens } } })` |
| `test/unit/agents/acp/registry.test.ts` | `makeConfig(agentOverrides?)` → `makeNaxConfig({ agent: agentOverrides })` — 19 call sites; backward-compat test uses `{ agent: undefined as any }` |
| `test/unit/test-runners/resolver.test.ts` | `makeConfig(patterns?)` using `structuredClone(DEFAULT_CONFIG)` → `makeNaxConfig()` — 20 call sites |

### Batch 4 (PR #643 — merged)

| File | Reason |
|------|--------|
| `test/unit/pipeline/stages/prompt-acceptance.test.ts` | Bespoke `makeConfig()` — sparse cast → `makeSparseNaxConfig` |
| `test/unit/pipeline/stages/review-dialogue.test.ts` | Bespoke `makeConfig(dialogueEnabled, dialogueOverrides?)` — 14 call sites → `makeSparseNaxConfig` |
| `test/unit/pipeline/stages/review.test.ts` | Bespoke `makeConfig(triggers)` — 10 call sites → `makeSparseNaxConfig` |
| `test/unit/pipeline/stages/verify.test.ts` | DEFAULT_CONFIG spreader with conditional → `makeNaxConfig` |
| `test/unit/pipeline/stages/routing-persistence.test.ts` | Bespoke `makeConfig()` — 1 call site → `makeNaxConfig({ tdd: { greenfieldDetection: false } })` |
| `test/unit/pipeline/stages/routing-initial-complexity.test.ts` | Bespoke `makeConfig()` — 1 call site → `makeNaxConfig({ tdd: { greenfieldDetection: false } })` |
| `test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts` | Sparse `as unknown as NaxConfig` cast → `makeSparseNaxConfig` |
| `test/unit/cli/plan-decompose-ac-repair.test.ts` | Factory was `makeNaxConfig` wrapper → inlined (6 call sites) |
| `test/unit/cli/plan-decompose-writeback.test.ts` | Factory was `makeNaxConfig` wrapper → inlined (7 call sites) |
| `test/unit/agents/manager-iface-run.test.ts` | Factory was `makeNaxConfig` wrapper → inlined (11 call sites) |

### Batch 5 (this branch — pending PR)

| File | Reason |
|------|--------|
| `test/unit/pipeline/stages/routing-idempotence.test.ts` | Factory was `makeNaxConfig` wrapper → inlined (1 call site) |
| `test/unit/pipeline/stages/execution-ambiguity.test.ts` | Factory was `makeNaxConfig` wrapper with bespoke trigger param → inlined (7 call sites) |
| `test/unit/pipeline/stages/execution-tdd-simple.test.ts` | Bespoke `makeConfig()` — sparse cast → `makeSparseNaxConfig` (1 call site via `makeCtx`)

---

## Pattern B files with Pattern A issues (see Batch 2 above)

These files are skipped under Batch 2 (makeStory) but also have Pattern A violations — listed here for completeness:

- `test/unit/pipeline/stages/prompt-batch.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/pipeline/stages/completion-semantic.test.ts` — Pattern B: positional args; Pattern A: sparse cast
- `test/unit/execution/lifecycle-execution.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/execution/story-context.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/execution/runner-completion-skip.test.ts` — Pattern B: positional args; Pattern A: DEFAULT_CONFIG spreader
- `test/unit/verification/rectification-loop.test.ts` — Pattern B: bespoked makeStory; Pattern A: bespoked makeConfig
- `test/unit/verification/rectification-loop-escalation.test.ts` — Pattern B: bespoked makeStory; Pattern A: bespoked makeConfig
- `test/unit/context/engine/orchestrator-factory.test.ts` — Pattern B: bespoked makeStory; Pattern A: ContextPluginProviderConfig
