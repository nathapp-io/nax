# Issue #745 — ConfigSelector Migration Plan

**Issue:** [#745](https://github.com/nathapp-io/nax/issues/745) — `refactor(config): migrate remaining NaxConfig direct usages to configSelector`
**ADR reference:** ADR-015 (`ConfigSelector<C>`)
**Date:** 2026-04-30
**Strategy:** TDD-first — stripped-config tests validate selector completeness before signature changes.

---

## Background

ADR-015 introduced `ConfigSelector<C>` so each subsystem declares the exact `NaxConfig` slice it depends on. A broad audit found ~60 leaf functions still accept `config: NaxConfig` directly (out of 132 total occurrences outside `src/config/`).

This plan migrates them in **6 phases**, ordered by risk (lowest first) and prerequisite chain. Each phase ships as a separate PR.

---

## Guiding Principles

1. **TDD validates selector completeness.** For every function being migrated, write a "stripped-config" test that constructs a config containing only the selector's declared keys and exercises the function. If the test fails, the selector is incomplete — either widen it or confirm the field isn't actually needed.
2. **Selector widening before code migration.** Type-narrowing param signatures will silently compile (because `Pick<NaxConfig, K>` is structurally compatible with `NaxConfig`), but reads of undeclared fields will return `undefined` at runtime. The stripped-config test catches this.
3. **One subsystem per PR.** Atomic changes, independent rollback.
4. **Backward-compatible by design.** Callers passing full `NaxConfig` still satisfy `Pick<NaxConfig, K>` — no caller updates required.

---

## Risk Summary

| Phase | Subsystem | Risk | Selector status |
|:---|:---|:---|:---|
| 1 | New selectors + selector widening | Low | Foundation work |
| 2 | `src/interaction/triggers.ts` | None | Selector exact match confirmed |
| 3 | `AgentManager` | Low | One type fix in `MiddlewareContext` required |
| 4 | Debate / review / tdd / routing runners | Low–Medium | Selectors widened in Phase 1 |
| 5 | `src/precheck/` | High | Reads 5 top-level keys; needs careful selector design |
| 6 | Audit + close-out | Low | Document remaining exceptions |

---

## Phase 1 — Selector Foundation

**Goal:** Add new selectors and widen existing ones so subsequent phases have correct types to migrate to.

### 1.1 Add new selectors

[src/config/selectors.ts](src/config/selectors.ts):

```typescript
export const agentManagerConfigSelector = pickSelector("agent-manager", "agent", "execution");
export const interactionConfigSelector  = pickSelector("interaction", "interaction");
export const precheckConfigSelector     = pickSelector("precheck", "precheck", "quality", "execution", "prompts", "review");
export const qualityConfigSelector      = pickSelector("quality", "quality", "execution");
```

> **Note:** `precheckConfigSelector` covers 5 top-level keys (not just `precheck`) — see Phase 5 for full justification.

### 1.2 Widen existing selectors

| Selector | Before | After | Reason |
|:---|:---|:---|:---|
| `debateConfigSelector` | `("debate", "debate")` | `("debate", "debate", "models")` | `resolveModelDefForDebater()` reads `config.models` |
| `reviewConfigSelector` | `("review", "review", "debate")` | `("review", "review", "debate", "models", "execution")` | `dialogue.ts` reads `models` (line 245) and `execution.sessionTimeoutSeconds` (line 249) |
| `tddConfigSelector` | `("tdd", "tdd", "execution")` | `("tdd", "tdd", "execution", "quality", "agent", "models")` | `session-runner.ts` reads `quality.commands`, `quality.testing`, `agent.maxInteractionTurns`, `models` |
| `routingConfigSelector` | `("routing", "routing")` | `("routing", "routing", "autoMode", "tdd")` | `router.ts` reads `autoMode.complexityRouting` (line 92), `tdd.strategy` (line 102) |

### 1.3 Export from barrel

Update [src/config/index.ts](src/config/index.ts) to re-export the four new selectors.

### 1.4 Tests

For each new and widened selector, add round-trip tests in `test/unit/config/selectors.test.ts`:

```typescript
test("precheckConfigSelector picks all keys precheck/* uses", () => {
  const slice = precheckConfigSelector.pick(SAMPLE_FULL_CONFIG);
  expect(slice).toMatchObject({
    precheck: expect.any(Object),
    quality: expect.any(Object),
    execution: expect.any(Object),
    prompts: expect.any(Object),
    review: expect.any(Object),
  });
});
```

### Acceptance

- [ ] Four new selectors exported from `src/config`
- [ ] Four existing selectors widened
- [ ] Selector unit tests pass
- [ ] `bun run typecheck` clean
- [ ] `bun run test` clean

### Risk: Low. Pure additive work.

---

## Phase 2 — Migrate `src/interaction/triggers.ts`

**Goal:** Migrate 11 functions to `Pick<NaxConfig, "interaction">`.

### Why first (after foundation)

- Confirmed via grep: every `triggers.ts` function only reads `interaction.triggers[name]` and `interaction.defaults`.
- Zero risk of underdeclared fields.
- Smallest, cleanest PR — establishes the migration pattern for reviewers.

### 2.1 RED — Stripped-config tests

Create `test/unit/interaction/triggers-narrowed.test.ts`:

```typescript
test("isTriggerEnabled — works with narrowed config slice", () => {
  const sliced = {
    interaction: {
      triggers: { autoApprove: { enabled: true } },
      defaults: { timeoutSeconds: 30, fallback: "approve" },
    },
  };
  expect(isTriggerEnabled("autoApprove", sliced as NaxConfig)).toBe(true);
});
```

Repeat per function (11 total). Run — should pass with current `NaxConfig` signature; this baseline confirms the selector is complete.

### 2.2 GREEN — Migrate signatures

Change all 11 function params from `config: NaxConfig` → `config: Pick<NaxConfig, "interaction">` (or use the selector's projected type).

Files:
- [src/interaction/triggers.ts](src/interaction/triggers.ts) — 11 functions

### 2.3 Acceptance

- [ ] All 11 functions migrated
- [ ] Stripped-config tests pass
- [ ] Existing tests pass (no behavior change)
- [ ] `grep -n "config: NaxConfig" src/interaction/triggers.ts` returns 0

### Risk: None.

---

## Phase 3 — Migrate `AgentManager`

**Goal:** Narrow `AgentManager._config` from `NaxConfig` to `Pick<NaxConfig, "agent" | "execution">`.

### 3.1 Pre-work — Fix `MiddlewareContext.config` type

**Blocker:** [src/runtime/agent-middleware.ts:10](src/runtime/agent-middleware.ts#L10) declares `MiddlewareContext.config: NaxConfig`. Line 501 of [src/agents/manager.ts](src/agents/manager.ts) assigns `this._config` into it. Narrowing `_config` will fail this assignment.

**Fix:** Change `MiddlewareContext.config` type:

```typescript
// src/runtime/agent-middleware.ts
export interface MiddlewareContext {
  // ...
  readonly config: Pick<NaxConfig, "agent" | "execution">;
  // ...
}
```

**Validation:** Audit all middleware implementations under `src/runtime/`. Per the source comment ("the only remaining middleware after ADR-020 Wave 1"), only `cancellationMiddleware` is active and reads no config fields — safe to narrow.

### 3.2 RED — Stripped-config tests

Create `test/unit/agents/manager-narrowed.test.ts`:

```typescript
test("AgentManager works with narrowed config", async () => {
  const sliced = {
    agent: { default: "claude", fallback: { enabled: false, map: {} } },
    execution: { permissionProfile: "safe" },
  };
  const mgr = createAgentManager(sliced as NaxConfig);
  expect(mgr.getDefault()).toBe("claude");
  // Exercise resolveFallbackChain, shouldSwap, nextCandidate
});
```

### 3.3 GREEN — Narrow types

Migrate in this order:

1. [src/agents/utils.ts](src/agents/utils.ts) — `resolveDefaultAgent(config)` → `Pick<NaxConfig, "agent">`
2. [src/agents/registry.ts](src/agents/registry.ts) — `createAgentRegistry(config)` → `Pick<NaxConfig, "agent">`
3. [src/agents/manager.ts](src/agents/manager.ts):
   - Line 66: `private readonly _config: Pick<NaxConfig, "agent" | "execution">`
   - Line 81: constructor param `config: Pick<NaxConfig, "agent" | "execution">`
4. [src/agents/factory.ts](src/agents/factory.ts) — `createAgentManager(config)` → matching type
5. [src/runtime/internal/agent-manager-factory.ts](src/runtime/internal/agent-manager-factory.ts) — same

**Note:** `runOptions.config` and `options.config` (per-call) remain `NaxConfig | undefined` — they are caller-owned and read `models`, `agent.acp.promptRetries`, `execution.permissionProfile`. Not part of `_config`.

### 3.4 Acceptance

- [ ] `MiddlewareContext.config` narrowed
- [ ] `AgentManager._config` narrowed
- [ ] `resolveDefaultAgent`, `createAgentRegistry`, `createAgentManager` narrowed
- [ ] Stripped-config tests pass
- [ ] All existing AgentManager tests pass
- [ ] `bun test test/unit/agents/ --timeout=30000` clean

### Risk: Low. Single type-level blocker (MiddlewareContext) handled in step 3.1.

---

## Phase 4 — Subsystem Runners (Existing Selectors)

**Goal:** Migrate runners in debate / review / tdd / routing to use the selectors widened in Phase 1.

### 4.1 Debate runners

**Files:**
- [src/debate/runner.ts](src/debate/runner.ts:43)
- [src/debate/runner-stateful.ts](src/debate/runner-stateful.ts:33)
- [src/debate/runner-hybrid.ts](src/debate/runner-hybrid.ts:39)
- [src/debate/runner-plan.ts](src/debate/runner-plan.ts:33)
- [src/debate/session-helpers.ts](src/debate/session-helpers.ts:156) (`resolveModelDefForDebater`)

**Selector:** `debateConfigSelector` → `Pick<NaxConfig, "debate" | "models">`

**RED test:** Construct config with only `debate` + `models` keys; verify debate runner produces correct outcome.

**Note:** `this.config` in runners is only passed downstream to `resolveOutcome()` → `resolveModelDefForDebater()` (reads `models`). The runner itself doesn't access `this.config.*` directly (uses `this.stageConfig` instead).

### 4.2 Review runner

**Files:**
- [src/review/dialogue.ts](src/review/dialogue.ts:220)
- [src/review/runner.ts](src/review/runner.ts)
- [src/review/semantic.ts](src/review/semantic.ts)
- [src/review/adversarial.ts](src/review/adversarial.ts)

**Selector:** `reviewConfigSelector` → `Pick<NaxConfig, "review" | "debate" | "models" | "execution">`

**RED test:** Stripped config with only those four keys; verify dialogue.ts paths (lines 245, 249, 350, 472) work.

### 4.3 TDD session runner

**File:** [src/tdd/session-runner.ts](src/tdd/session-runner.ts:43)

**Selector:** `tddConfigSelector` → `Pick<NaxConfig, "tdd" | "execution" | "quality" | "agent" | "models">`

**RED test:** Stripped config covering all read sites:
- Line 174–199: `quality.commands.test`, `quality.testing`
- Line 213: `execution.rectification.enabled`
- Line 220: `models`
- Line 225: `execution.sessionTimeoutSeconds`
- Line 229: `agent.maxInteractionTurns`
- Line 310–311: `execution.smartTestRunner.testFilePatterns`
- Line 314: `tdd.testWriterAllowedPaths`

### 4.4 Routing router

**File:** [src/routing/router.ts](src/routing/router.ts)

**Selector:** `routingConfigSelector` → `Pick<NaxConfig, "routing" | "autoMode" | "tdd">`

**RED test:** Stripped config; verify:
- Line 92: `autoMode.complexityRouting`
- Line 102: `tdd.strategy`
- Line 180: `routing.strategy`
- Line 280–281: `routing.llm.mode`, `routing.strategy`

### 4.5 Acceptance

Per file:
- [ ] Stripped-config test added and passing
- [ ] Param type narrowed
- [ ] Existing tests pass
- [ ] `grep -n "config: NaxConfig" <file>` returns 0

### Risk: Low–Medium. The 4 widened selectors in Phase 1 cover all observed reads. Any miss surfaces immediately as a stripped-config test failure.

---

## Phase 5 — `src/precheck/` Migration

**Goal:** Migrate 10+ leaf functions in precheck. Highest risk because reads span 5 top-level config keys.

### 5.1 Function-to-key map

| Function | File | Keys read |
|:---|:---|:---|
| `checkTestCommand()` | `checks-system.ts:41` | `quality.commands.test`, `execution.testCommand` |
| `checkLintCommand()` | `checks-system.ts:62` | `execution.lintCommand`, `quality.commands.lint` |
| `checkTypecheckCommand()` | `checks-system.ts:83` | `execution.typecheckCommand`, `quality.commands.typecheck` |
| `checkAgentCLI()` | `checks-cli.ts:43` | `agent.*` *(verify in PR)* |
| `checkOptionalCommands()` | `checks-warnings.ts:104` | `quality.commands.lint/typecheck`, `execution.lintCommand/typecheckCommand` |
| `checkPromptOverrideFiles()` | `checks-warnings.ts:188` | `prompts.overrides` |
| `checkBuildCommandInReviewChecks()` | `checks-warnings.ts:398` | `review.commands.build`, `review.checks`, `quality.commands.build` |
| `analyzeStory()` | `story-size-gate.ts:44` | `precheck.storySizeGate` |
| `checkStorySizeGate()` | `story-size-gate.ts:91` | `precheck.storySizeGate` |
| `getEnvironmentBlockers()` / `getLateEnvironmentBlockers()` | `index.ts:110, 122` | delegates |
| `checkAll()` | `index.ts:235` | delegates + `project` (via `checkLanguageTools(config.project)`) |

### 5.2 Selector decision

Two viable approaches:

**Option A — Single broad selector (recommended for Phase 5).**

```typescript
precheckConfigSelector = pickSelector("precheck", "precheck", "quality", "execution", "prompts", "review", "project", "agent");
```

Pro: One signature for all precheck functions. Reads stay grouped.
Con: Wide; obscures per-function dependencies.

**Option B — Per-function selectors.**

```typescript
qualityConfigSelector = pickSelector("quality", "quality", "execution");
storyGateConfigSelector = pickSelector("story-gate", "precheck");
promptCheckSelector = pickSelector("prompt-check", "prompts");
buildCheckSelector = pickSelector("build-check", "review", "quality");
// etc.
```

Pro: Tight per-function scope. Better self-documentation.
Con: 5+ selectors for one subsystem; `index.ts` orchestrators must merge them.

**Recommendation:** Ship Option A in Phase 5 to unblock the migration. Refactor to Option B in a follow-up if precheck contributors find the broad type unhelpful.

### 5.3 Migration order (within Phase 5)

Bottom-up to avoid orphan-type errors:

1. Leaf check functions in `checks-system.ts`, `checks-cli.ts`, `checks-warnings.ts`, `story-size-gate.ts`
2. `index.ts` orchestrators (`getEnvironmentBlockers`, `getEnvironmentWarnings`, `getLateEnvironmentBlockers`, `checkAll`)
3. Callers in `src/execution/lifecycle/precheck-runner.ts` (already passes a runtime `config`, no signature change required)

### 5.4 RED tests

Per function — stripped config with only its declared keys:

```typescript
test("checkTestCommand — narrowed config", async () => {
  const sliced = {
    quality: { commands: { test: "bun test" } },
    execution: { testCommand: undefined },
  };
  const result = await checkTestCommand(sliced as NaxConfig);
  expect(result.status).toBe("pass");
});
```

A test that omits `quality.commands.test` and `execution.testCommand` should produce `status: "fail"` — confirming both fallback paths are exercised.

### 5.5 Acceptance

- [ ] `precheckConfigSelector` covers all 5 keys
- [ ] All 10+ precheck functions migrated
- [ ] Stripped-config tests pass for each function
- [ ] Existing tests pass
- [ ] `grep -n "config: NaxConfig" src/precheck/` returns 0

### Risk: High → Medium with TDD.

The risk is that a function silently reads a key not in the selector and returns `undefined`-derived results. The stripped-config tests turn this into compile-time / test-time failures. With Phase 5's TDD discipline, risk drops to medium.

---

## Phase 6 — Audit & Close-out

**Goal:** Verify no regressions and document remaining `config: NaxConfig` exceptions.

### 6.1 Audit script

```bash
grep -rn "config: NaxConfig" src/ --include="*.ts" | grep -v "src/config/" | sort > /tmp/post-migration-audit.txt
```

Expected remaining sites (legitimate, not migrated):
- `src/execution/` — initialization layer with broad config access
- `src/runtime/` — runtime construction
- `src/cli/` — entry points
- `src/context/` — provider scope; broad access acceptable per ADR-015
- `src/agents/types.ts` — public interface types (`AgentRunOptions.config: NaxConfig`)
- `src/operations/build-hop-callback.ts` — hop callback receives full config

Document each remaining usage in a comment or in `docs/architecture/ARCHITECTURE.md` § ADR-015 follow-up.

### 6.2 Lint rule (optional)

Add a Biome custom rule or grep-based pre-commit check that fails when `config: NaxConfig` is added outside the documented exception list.

### 6.3 Acceptance criteria (issue #745)

- [ ] `grep -rn "config: NaxConfig" src/ --include="*.ts"` returns only documented exceptions
- [ ] `bun run typecheck` clean
- [ ] `bun run test` clean
- [ ] No existing tests modified (param narrowing is backward-compatible)
- [ ] PR descriptions reference issue #745 and the phase number

---

## Sequencing & PR Strategy

```
Phase 1 (selectors)            ──┐
                                 │
       ┌─────────────────────────┼──── PR #1
       │                         │
       ▼                         │
Phase 2 (interaction)            │
       │                         │
       ▼                         │
Phase 3 (AgentManager)           │
       │                         │
       ▼                         │
Phase 4a (debate runners)  ──────┤
Phase 4b (review runners)  ──────┤  Independent — can ship in parallel
Phase 4c (tdd runner)      ──────┤
Phase 4d (routing router)  ──────┤
       │                         │
       ▼                         │
Phase 5 (precheck)               │
       │                         │
       ▼                         │
Phase 6 (audit)            ──────┘
```

**One PR per phase** (Phase 4 may be 4 PRs in parallel). Recommended cadence: one phase per day for phases 1–3, parallel work for phase 4, dedicated review cycle for phase 5.

---

## Out of Scope

Per issue #745, "lower priority — intentionally broad" subsystems are NOT migrated:

- `src/execution/` — Runner, lifecycle, parallel execution (orchestration layer)
- `src/context/` — Context engine (provider scope is documented; broad access intentional)
- `src/runtime/` — Runtime construction (must see whole config)
- `src/cli/` — CLI entry points (load + pass config; no narrowing benefit)

These are tracked as legitimate exceptions in Phase 6.

---

## Rollback Plan

Each phase is an independent PR with no cross-phase dependencies (after Phase 1). To roll back:

1. Revert the phase's PR.
2. The widened selectors from Phase 1 remain — they're additive and harmless.
3. Cancel/revert downstream phases that depend on the rolled-back work.

No data migrations or persisted-state changes — purely a type-system refactor.

---

## Success Metrics

- **Direct `NaxConfig` usages outside `src/config/`:** 132 → ~50 (62% reduction)
- **Subsystems with declared config slice:** 7 → 11
- **Selector-driven boundaries:** AgentManager, precheck, interaction, debate, review, tdd, routing all explicit
- **Onboarding signal:** New contributors immediately see "this function only reads X keys" from the type alone

---

## Open Questions

1. **`MiddlewareContext.config` type** — narrow to `Pick<NaxConfig, "agent" | "execution">` (assumes no future middleware needs `quality`/`models`/etc.) or leave as `NaxConfig` and stop assigning `this._config` directly? **Recommendation:** narrow, since the only active middleware (cancellation) reads nothing.
2. **`precheckConfigSelector` granularity** — Option A (broad) vs Option B (per-function). **Recommendation:** Option A for now; revisit in follow-up.
3. **`createAgentManager` factory** — should `opts.config` also narrow? Currently passes through to constructor; narrowing aligns the public API. **Recommendation:** narrow in Phase 3.

---

## References

- Issue: [#745](https://github.com/nathapp-io/nax/issues/745)
- ADR: [ADR-015 — ConfigSelector](docs/adr/ADR-015-config-selectors.md) *(verify path)*
- Related ADRs: ADR-012 (agent ownership), ADR-018 (runtime layering), ADR-020 (middleware)
- Project rule: `.claude/rules/config-patterns.md`
