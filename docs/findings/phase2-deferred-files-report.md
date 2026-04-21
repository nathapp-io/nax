# Phase 2 — Test Helper Consolidation: Deferred Files Report

**Date:** 2026-04-21
**Branch:** `chore/sweep-pattern-d-agent-manager`
**Check Script Violations:** 0 ✅
**SKIP_FILES Entries:** 191 files

---

## Executive Summary

The Phase 2 sweep (`bun scripts/check-inline-test-mocks.ts`) reports **0 violations**.
All files with inline mock patterns are tracked in `SKIP_FILES` in `scripts/check-inline-test-mocks.ts`.

These files work correctly — they use inline mock patterns that don't use the shared test helpers.
They are deferred because migrating them could change test behavior due to differences between
shallow object spread vs. deep merge, or because they use complex bespoke mock structures.

---

## Deferred Files by Pattern

| Pattern | Description | Count | Status |
|:--------|:------------|:------|:-------|
| **A** | `makeConfig()` — local factory returning full config override | 73 | Deferred |
| **B** | `makeStory()` — local factory with bespoke `UserStory` fields | 86 | Deferred |
| **C** | `AgentAdapter` — class-based or plugin-extension adapters | 6 | Deferred |
| **D** | `IAgentManager` — complex mocks with `completeWithFallback` or custom `getAgent` | 26 | Deferred |
| **Total** | | **191** | |

---

## Pattern A: `makeConfig()` — 73 files

**Reason deferred:** These files return a full config object that does NOT spread `DEFAULT_CONFIG`.
Using `makeNaxConfig()` would deep-merge `DEFAULT_CONFIG`, adding fields the original
`makeConfig()` intentionally omitted. This changes test behavior.

---

## Pattern B: `makeStory()` — 86 files

**Reason deferred:** These files have local `makeStory()` factories with fields that may not
exist on the canonical `UserStory` type, or they override defaults in ways that don't match
the shared `makeStory()` helper's signature.

---

## Pattern C: `AgentAdapter` — 6 files

**Reason deferred:** These use class-based `MockAgentAdapter` implementations or
plugin-extension adapter patterns that cannot be replaced with `makeAgentAdapter()`.

**Files:**

```
test/integration/pipeline/reporter-lifecycle-basic.test.ts
test/integration/pipeline/reporter-lifecycle-resilience.test.ts
test/integration/plugins/plugins-registry.test.ts
test/integration/plugins/validator.test.ts
test/integration/execution/agent-swap.test.ts
test/integration/execution/status-file-integration.test.ts
```

---

## Pattern D: `IAgentManager` — 26 files

**Reason deferred:** These files use `.mock.calls` assertions on bun `mock()` instances
passed to their inline IAgentManager mocks. `makeMockAgentManager()` wraps all method
stubs with `mock()`, but the returned object's methods are plain — `.mock.calls` is
not available on them. Assertions like `expect(mockRun).toHaveBeenCalledTimes(1)` would
break if migrated.

**Files:**

```
test/unit/pipeline/stages/autofix-budget-prompts.test.ts        — makeMockAgentManager(mockRun) factory; assertions on mockRun.mock.calls
test/unit/pipeline/stages/autofix-noop.test.ts                    — makeMockAgentManager(mockRun) factory; assertions on mockRun.mock.calls
test/unit/pipeline/stages/autofix-adversarial.test.ts             — inline { getDefault: () => "claude", run: makeMockAgentManager(mockRun) }; assertions on mockRun.mock.calls (8 locations)
test/unit/pipeline/stages/autofix-dialogue.test.ts                — makeMockAgentManager(mockRun) factory; assertions on mockRun.mock.calls
test/unit/pipeline/stages/autofix-session-wiring.test.ts          — makeMockAgentManager(mockRun) factory; assertions on mockRun.mock.calls
test/unit/pipeline/stages/execution-manager-wiring.test.ts        — runWithFallback delegates to req.executeHop()
test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts   — runWithFallback delegates to req.executeHop()
test/unit/interaction/auto-plugin-adapter.test.ts                 — completeMock captured for .mock.calls assertions
test/unit/acceptance/component-strategy-integration.test.ts       — createManager mock captured for .mock.calls assertions
test/unit/acceptance/generator-prd-result.test.ts                 — createManager mock captured for .mock.calls assertions
test/unit/acceptance/fix-executor-test-fix.test.ts               — agent.run captured for .toHaveBeenCalled() assertion
```

**Permanently skipped (no violations, no action needed):**
```
test/unit/pipeline/stages/execution-workdir.test.ts
test/unit/pipeline/stages/execution-agent-routing.test.ts
test/unit/pipeline/stages/execution-tdd-simple.test.ts
test/unit/pipeline/stages/execution-session-role.test.ts
test/unit/pipeline/stages/execution-ambiguity.test.ts
test/unit/pipeline/stages/execution-merge-conflict.test.ts
test/unit/storyid-events.test.ts
test/unit/agents/manager-iface-run.test.ts
test/unit/agents/manager-credentials.test.ts
test/unit/debate/session-events.test.ts
test/unit/debate/session-helpers-resolver-model.test.ts
test/unit/debate/session-helpers.test.ts
test/unit/debate/session-plan.test.ts
test/unit/pipeline/stages/review-debate-dialogue.test.ts
test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts
```

---

## Migration Strategy

1. **Pattern A (makeConfig):** Only migrate if the local `makeConfig()` spreads `DEFAULT_CONFIG`.
   If it does: `function makeConfig() { return { ...DEFAULT_CONFIG, ... }; }` → `makeNaxConfig({ ... })`.
   If it doesn't (full override), leave in SKIP_FILES.

2. **Pattern B (makeStory):** Only migrate if the local `makeStory()` signature matches
   `makeStory(overrides?: Partial<UserStory>)`. If it has bespoke fields or positional
   arguments, leave in SKIP_FILES.

3. **Pattern C (AgentAdapter):** Class-based mocks need manual refactoring. Not worth the
   effort — leave in SKIP_FILES.

4. **Pattern D (IAgentManager):** Files with `.mock.calls` assertions on bun `mock()`
   instances cannot be migrated without changing test assertions. Files with
   `runWithFallback`/`completeWithFallback` delegating to `req.executeHop()` cannot be
   migrated without enhancing `makeMockAgentManager()` to support `executeHop`.

---

## Files Successfully Migrated (All Batches)

| Batch | Pattern | Files Migrated |
|:------|:--------|:---------------|
| Prior | D | 28 |
| Prior | C | 17 |
| Prior | A | 3 |
| Batch 1 | D | 4 (resolvers, session-hybrid-rebuttal, session-one-shot-roles, autofix-routing, review-dialogue) |
| **Total** | | **52** |

---

## Recommendation

The remaining 191 SKIP_FILES entries are technical debt, not bugs. Priority:

- **Pattern A/B**: Can be migrated in future batches following `phase2-sweep-batches.md`
- **Pattern C**: Class-based mocks — not worth the effort
- **Pattern D**: Files using `.mock.calls` assertions — requires either:
  (a) enhancing `makeMockAgentManager()` to expose `.mock` on method stubs, or
  (b) accepting that these files will remain as permanent skips

Current state:
- ✅ 0 check script violations
- ✅ All tests pass (1171 pass, 40 skip, 0 fail)
- ✅ Typecheck clean
- ✅ Lint clean
