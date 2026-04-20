# ADR-012 Implementation Review — Phases 1 to 6

**Reviewer:** code-reviewer subagent
**Date:** 2026-04-20
**Base commit:** 45204abf (main)
**Spec:** docs/specs/SPEC-agent-manager-integration.md
**ADR:** docs/adr/ADR-012-agent-manager-ownership.md

## Verdict

**PASS-WITH-FINDINGS.** Phases 1 through 6 are substantively implemented. `AgentManager` is constructed once per run (`src/execution/runner.ts:120`), threaded through `PipelineContext` (`src/pipeline/types.ts:137`), and drives the full swap loop from `src/pipeline/stages/execution.ts:184` via `runWithFallback`. The migration shim, `AllAgentsUnavailableError`, `agent-swap.ts`, adapter-owned fallback state, and legacy `autoMode.defaultAgent` / `autoMode.fallbackOrder` / `context.v2.fallback` fields are all gone from `src/` (verified by `src/agents/utils.ts`, `src/config/schemas.ts:57`, `src/config/loader.ts`, and `test/unit/config/phase6-invariants.test.ts`). However, four material gaps remain vs. stated acceptance criteria: (1) **Phase 6 silent-strip**: Zod's default `.strip()` behavior means pre-migration configs silently lose `autoMode.defaultAgent` / `context.v2.fallback` instead of producing the advertised Zod validation error — the CHANGELOG entry overstates the enforcement. (2) **Phase 5 cost aggregation**: `AgentFallbackRecord.costUsd` is populated on the manager but is **dropped** when copied to `ctx.agentFallbacks` (execution.ts:302-310), and `AgentFallbackHop` lacks a `costUsd` field. (3) **Phase 5 `RunSummary.fallback` aggregates are never surfaced** — no `deriveRunFallbackAggregates`, no `totalHops` / `perPair` / `exhaustedStories` / `totalWastedCostUsd` on `RunSummary`. (4) **Phase 3 codemod artefact missing** — `scripts/codemods/agent-manager-migration.ts` not preserved. None of these block correctness for the happy-path fallback flow (integration test `test/integration/execution/agent-swap.test.ts` is green), but #519 is under-delivered and the Phase 6 error-message AC is factually unmet. Recommend follow-ups before claiming #519 closed.

## Phase 1 — AgentManager skeleton

### Acceptance criteria

| AC | Evidence | Status | Notes |
|:---|:---|:---|:---|
| `IAgentManager` exported from `src/agents/manager.ts` via `src/agents` barrel | `src/agents/manager-types.ts:64` declares `IAgentManager`; `src/agents/index.ts:18-27` re-exports `AgentManager`, `IAgentManager`, etc. | Pass | |
| `PipelineContext.agentManager` populated by `Runner` — exactly one instance per run | `src/execution/runner.ts:120` `const agentManager = new AgentManager(config, registry);` threaded through `setupRun` (`:144`) and `runExecutionPhase` (`:183`). `src/pipeline/types.ts:137` types the field. Grep confirms a single production construction site. | Pass | |
| `AgentManager.getDefault()` legacy pass-through | No longer reads legacy path — Phases 2/6 migrated this to `config.agent.default` at `src/agents/manager.ts:55-59`. Phase 1's "pass-through to `autoMode.defaultAgent`" is superseded intentionally. | Pass (superseded) | |
| `shouldSwap`, `nextCandidate`, `runWithFallback` methods exist | `src/agents/manager.ts:108,118,128` | Pass | Phase 4 upgraded these from thin wrappers to real implementations. |
| All existing tests pass | Not re-run here; ADR checkbox marks done. | Not verified | |
| `test/unit/agents/manager.test.ts` covers `getDefault()`, per-run state isolation, event emission | `test/unit/agents/manager.test.ts` exists (6.7K). `test/unit/agents/agent-manager-reset.test.ts` covers `reset()`. | Pass | |
| No config changes in Phase 1 | Historic — not verifiable from current state. | N/A | |

### Findings

- Phase 1's pass-through is intentionally absent from the current code because later phases replaced it. Spec text is stale; do not treat as regression.

## Phase 2 — Config consolidation + migration shim

### Acceptance criteria

| AC | Evidence | Status | Notes |
|:---|:---|:---|:---|
| `AgentConfigSchema` uses Zod `.default()` values | `src/config/schemas.ts:715-735` — `AgentFallbackConfigSchema` and `AgentConfigSchema` both use `.default(...)`. Schema is SSOT. | Pass | |
| `applyAgentConfigMigration()` migrated 3 legacy keys with warn-once semantics | Shim was implemented in Phase 2 and **intentionally deleted in Phase 6**. No longer present in `src/config/loader.ts`. | Pass (historic) | |
| Mixed legacy + canonical config — canonical wins, warning still emitted | Historical behavior; shim deleted. | N/A post-Phase 6 | |
| `AgentManager.getDefault()` reads `config.agent.default` first, falls back to legacy | `src/agents/manager.ts:55-59` reads only `this._config.agent?.default`, falls back to literal `"claude"`. No legacy fallback. | Pass (superseded by Phase 6) | |
| `AgentManager.validateCredentials()` called from `runSetupPhase()` | `src/execution/lifecycle/run-setup.ts:127-129` awaits `options.agentManager.validateCredentials()`. Implementation at `src/agents/manager.ts:75-100`: throws `NaxError AGENT_CREDENTIALS_MISSING` for primary, logs + prunes for fallback. | Pass | |
| `test/unit/config/loader-migration.test.ts` covers 3 keys × 3 shapes | **Not present** (likely deleted with the shim in Phase 6). | Warn | Coverage for the historic shim is gone; not a live-code concern but reduces audit trail. |
| `test/unit/execution/lifecycle/run-setup.test.ts` covers credential pre-validation | `test/unit/agents/manager-credentials.test.ts` exists (3.1K) covering `validateCredentials()`. Run-setup-specific test not verified, but coverage exists. | Pass | |
| T16.3 dogfood canary passes | Not executed in this review. | Not verified | |

### Findings

- `AgentConfigSchema.protocol` narrowed from `z.enum(["acp", "cli"])` (per spec §Interface Changes) to `z.literal("acp").default("acp")` at `src/config/schemas.ts:724`. Divergence from spec; intentional because `cli` protocol is retired. Does not break anything but worth calling out in the ADR-012 text.

## Phase 3 — Call-site migration

### Acceptance criteria

| AC | Evidence | Status | Notes |
|:---|:---|:---|:---|
| No src file reads `config.autoMode.defaultAgent` | `grep -rn "autoMode.defaultAgent" src/` returns 0 hits (confirmed by `test/unit/config/phase6-invariants.test.ts:40-49`). | Pass | |
| No src file reads `config.autoMode.fallbackOrder` | Same grep, 0 hits (test at `phase6-invariants.test.ts:51-60`). | Pass | |
| No src file reads `context.v2.fallback` | 0 hits in `src/` (`Grep(context\.v2\.fallback, src/)` returned nothing). | Pass | |
| Canonical accessors used | `agentManager.getDefault()` used at 12+ sites under `src/pipeline/stages/` and `src/review/`; `resolveDefaultAgent(config)` at 26 files including `src/routing/`, `src/tdd/`, `src/acceptance/`, `src/debate/`, `src/verification/`, `src/cli/`. | Pass | |
| Full test suite green | Not run in review. | Not verified | |
| No behaviour change | Historic. | N/A | |
| Codemod artefact preserved in `scripts/codemods/agent-manager-migration.ts` | **Directory `scripts/codemods/` does not exist.** | Fail (minor) | Phase 3 plan called for this for auditability. Lost. |

### Findings

- Dual accessor pattern (`ctx.agentManager?.getDefault() ?? "claude"` **or** `resolveDefaultAgent(ctx.rootConfig ?? ctx.config)`) is live across the codebase. `src/pipeline/stages/routing.ts:34` uses both in one expression — acceptable, but the convention is not documented; `.claude/rules/adapter-wiring.md` picks one. Consider aligning.
- `ctx.agentManager?.getDefault() ?? "claude"` hardcodes `"claude"` as a second-line fallback in 6+ stages (`execution.ts:36`, `autofix.ts:483,491`, `autofix-adversarial.ts:67`, `rectify.ts:95`, `verify.ts:240`, `review.ts:37`, `context.ts:54`, `acceptance-setup.ts:230`). Works in practice, but duplicates the fallback constant — prefer routing every fallback through `resolveDefaultAgent(config)` (which already encodes the constant).

## Phase 4 — Remove adapter-owned fallback state

### Acceptance criteria

| AC | Evidence | Status | Notes |
|:---|:---|:---|:---|
| #529 closed before Phase 4 | Historic — not verified. | N/A | |
| `AcpAgentAdapter._unavailableAgents` deleted | Not present in `src/agents/acp/adapter.ts`. Only a comment at `src/execution/runner-execution.ts:50` and `src/execution/executor-types.ts:51` mentions it stale. | Pass | |
| `AcpAgentAdapter.resolveFallbackOrder()` deleted | Not present. Confirmed by `test/unit/agents/adapter-cleanup.test.ts:12-14`. | Pass | |
| `AcpAgentAdapter.markUnavailable()` deleted | Not present. | Pass | |
| `AllAgentsUnavailableError` deleted from `src/errors.ts` and `src/agents/index.ts` | 0 hits in `src/` (only in docs/plans/specs). Confirmed by `test/unit/agents/adapter-cleanup.test.ts:16-18`. | Pass | |
| Auth → adapter returns `{ success: false, adapterFailure: { category: "availability", outcome: "fail-auth" } }`, never throws | `src/agents/acp/adapter.ts:499-513, 539-553, 986-995` (both parsed-result path and catch path). | Pass | |
| Rate-limit → returns `adapterFailure: { category: "availability", outcome: "fail-rate-limit", retriable: true }` | `src/agents/acp/adapter.ts:515-531, 555-571, 997-1010`. Includes optional `retryAfterSeconds`. | Pass | |
| Invariant test: adapter never throws for classifiable failures | `test/unit/agents/adapter-cleanup.test.ts` asserts string absence; no runtime fuzz. `src/agents/manager.ts:168-183` has a last-resort catch to `{ category: "quality", outcome: "fail-unknown" }` as backstop. | Pass (partial) | Invariant enforced at boundary via try/catch in manager, not by adapter tests. Acceptable per spec §Failure Classification. |
| Transport retries remain in adapter | `sessionErrorRetryable` loop still present in `src/agents/acp/adapter.ts` (line ~491). | Pass | |
| Payload-shape retries in `src/review/semantic.ts`, `src/review/adversarial.ts` untouched | Not re-audited in detail, but ADR-012 scope excludes them explicitly. | Pass | |
| Integration test: simulated auth failure triggers swap with hop metadata | `test/integration/execution/agent-swap.test.ts` covers quota/auth → swap flow; asserts `ctx.agentFallbacks` populated. | Pass | |

### Findings

- `AcpAgentAdapter.clearUnavailableAgents()` is kept as a no-op (`src/agents/acp/adapter.ts:1097`) with a stale comment referencing Phase 4 ownership. Dead code maintained for interface compatibility with `AgentRegistry.resetStoryState()`. Cleanup opportunity: if no adapter will ever need per-story state, delete the method and the registry hook entirely and call `agentManager.reset()` instead (which is already called at `src/execution/iteration-runner.ts:196`).
- Stale references to `_unavailableAgents` as a concept live in `src/execution/runner-execution.ts:50` and `src/execution/executor-types.ts:51` comments. Low-priority doc cleanup.

## Phase 5 — Execution-stage consolidation

### Acceptance criteria

| AC | Evidence | Status | Notes |
|:---|:---|:---|:---|
| `pipeline/stages/execution.ts` LOC reduced by ≥120 | Current file is 397 lines with helper extraction. Pre-Phase-5 was 150+ lines of inline swap loop; now a single `runWithFallback` call at `src/pipeline/stages/execution.ts:184-299` (the branch is long but carries `executeHop` callback semantics). Qualitative: loop is collapsed. | Pass | |
| `src/execution/escalation/agent-swap.ts` deleted | Directory listing confirms not present (`escalation.ts`, `tier-escalation.ts`, `tier-outcome.ts`, `index.ts` remain). | Pass | |
| `context.v2.fallback` schema entry removed | No `ContextV2FallbackConfigSchema` in `src/config/schemas.ts` (confirmed by `test/unit/agents/phase5-invariants.test.ts:41-44`). | Pass | |
| `AgentFallbackRecord` includes `costUsd: number`, sourced from failed-hop `RunResult.estimatedCost` | `src/agents/manager-types.ts:18` declares `costUsd`; `src/agents/manager.ts:240` populates from `result.estimatedCost ?? 0`. | Pass on manager side | |
| `AgentFallbackRecord.costUsd` reaches metrics | **Fail** — execution.ts:302-310 strips `costUsd` when copying to `ctx.agentFallbacks`. `src/metrics/types.ts:76-86` `AgentFallbackHop` has no `costUsd` field. | Fail | See Cross-cutting → Dead code. |
| `RunSummary.fallback: { totalHops, perPair, exhaustedStories, totalWastedCostUsd }` surfaced at run completion | **Fail** — `RunSummary` at `src/pipeline/events.ts:15-28` has only stories/cost/duration fields. No aggregation helper (`deriveRunFallbackAggregates` does not exist). `RunMetrics` at `src/metrics/types.ts:192+` also lacks a fallback aggregate. | Fail | #519 AC unmet. |
| Snapshot tests for `context-manifest-rebuild-*.json` unchanged | Not re-run; `src/pipeline/stages/execution.ts:211-232` still calls `writeRebuildManifest` with the expected fields. | Pass (structural) | |
| T16.3 dogfood | Not executed. | Not verified | |
| `test/unit/metrics/tracker.test.ts` covers aggregation | No new aggregation code to cover — see above. | Fail | |
| `test/unit/execution/lifecycle/run-completion*.test.ts` covers run-summary surfacing | Same — no surfacing code to test. | Fail | |

### Findings

- **Phase 5 #519 fold-in is incomplete.** The manager records `costUsd` but the story-side `AgentFallbackHop` type drops it, and `RunSummary` / `RunMetrics` never aggregate. If #519 is still open, this phase's ADR checkbox should not be ticked until a follow-up PR lands:
  1. Add `costUsd: number` to `src/metrics/types.ts::AgentFallbackHop`.
  2. Propagate it in `src/pipeline/stages/execution.ts:302-310`.
  3. Add `RunMetrics.fallback?: { totalHops, perPair, exhaustedStories: string[], totalWastedCostUsd }` + a helper in `src/metrics/tracker.ts` or `src/metrics/aggregator.ts`.
  4. Surface in `src/execution/lifecycle/run-completion.ts`.
- `executeHop` callback in `execution.ts:188-273` is 86 lines of closure — straddles the 50-line function guideline. Readable but dense; consider extracting the hop-setup logic (bundle rebuild, manifest write, session handoff, prompt swap) into a helper `buildHop(ctx, agentName, ...)` to match the repo's "≤30 lines" function guideline.
- Rate-limit backoff in `src/agents/manager.ts:192-202` uses `_agentManagerDeps.sleep` (`Bun.sleep`) with base `2^attempt * 1000 ms` — up to 14s on attempt 3. The sleep is uncancellable. If a run is aborted during backoff, it will wait out the sleep. The project rules forbid "uncancellable `Bun.sleep`" (see `docs/architecture/async-patterns` / `.claude/rules/forbidden-patterns.md`). Consider `Promise.race` against an abort signal.
- Rate-limit fallback reset is correct: the retry counter is reset when a swap happens (`src/agents/manager.ts:228`) so the new agent gets its own budget.

## Phase 6 — Remove migration shim

### Acceptance criteria

| AC | Evidence | Status | Notes |
|:---|:---|:---|:---|
| `applyAgentConfigMigration()` deleted from `src/config/loader.ts` | No import or call site. `test/unit/config/phase6-invariants.test.ts:17-21` confirms. | Pass | |
| `defaultAgent`, `fallbackOrder` removed from `AutoModeConfigSchema` | `src/config/schemas.ts:57-70` — no such fields (confirmed by `test/unit/config/phase6-invariants.test.ts:23-38`). | Pass | |
| `ContextV2FallbackConfigSchema` removed | Not present in `src/config/schemas.ts`. | Pass | |
| Loading a pre-migration config → Zod validation error with clear "migrate to `agent.*` per ADR-012" message | **Fail** — `NaxConfigSchema` at `src/config/schemas.ts:853-1169` uses no `.strict()` / `.catchall()`; Zod default is `.strip()`. Pre-migration configs with `autoMode: { defaultAgent: "..." }` or `context: { v2: { fallback: ... } }` will be **silently stripped** and the run will proceed with defaults. No error, no warning. | Fail | Critical — see Silent-failure risks. |
| 3 canary releases have passed | ADR marks `[ ]` with note "N/A — internal project, no canary release process". | Acceptable | |
| CHANGELOG breaking-change note added | `CHANGELOG.md` line 15: "`autoMode.defaultAgent` and `autoMode.fallbackOrder` config fields removed. Use `agent.default` and `agent.fallback.map` instead (ADR-012 Phase 6). Loading a legacy config now fails Zod validation." | Pass with caveat | The final clause "now fails Zod validation" is inaccurate given the strip-mode behavior. |
| `docs/architecture/conventions.md` and `.claude/rules/config-patterns.md` updated | Grep for `ADR-012` / `agent.default` in both files returned **0 matches**. | Fail | AC checked on ADR but documentation not updated. |

### Findings

- **The marquee Phase 6 assurance — "loading a legacy config fails Zod validation with a clear migration message" — is unmet.** The fix is mechanical: add a pre-parse check in `src/config/loader.ts::loadConfig` that inspects raw merged config for legacy keys (`autoMode.defaultAgent`, `autoMode.fallbackOrder`, `context.v2.fallback`) and throws `NaxError CONFIG_LEGACY_AGENT_KEYS` with a migration message pointing at ADR-012. Alternative: switch the top-level `NaxConfigSchema` to `.strict()`, but that's a much bigger blast radius (every test fixture with an unknown key will break). Recommended fix is the targeted pre-parse check.
- **Dogfood concern:** anyone with an old `~/.nax/config.json` containing `autoMode.defaultAgent: "codex"` will silently revert to `agent.default = "claude"` and their fallback map will vanish. No log line flags this. This is exactly the "T16.3 silent no-op" failure mode the ADR was designed to prevent, re-introduced in a different form.

## Cross-cutting findings

### Wiring check

- `AgentManager` construction: single site at `src/execution/runner.ts:120` — `new AgentManager(config, registry)`. ✔
- Threaded to setup (`runSetupPhase` options → `setupRun` at `src/execution/lifecycle/run-setup.ts:127-129`): calls `validateCredentials()`. ✔
- Threaded to execution (`runExecutionPhase` options → `SequentialExecutionContext` → `PipelineContext.agentManager`). ✔
- Threaded to parallel branch: confirmed via `RunnerExecutionOptions.agentManager` at `src/execution/runner-execution.ts:59`. ✔
- Per-story `reset()` called at `src/execution/iteration-runner.ts:196` before pipeline run. ✔
- Execution stage uses `ctx.agentManager.runWithFallback({...})` at `src/pipeline/stages/execution.ts:184-299`. ✔
- Decompose / plan / review / acceptance sites use `resolveDefaultAgent(config)` — 26 consumer files. ✔

### Dead code check

| Finding | Location |
|:---|:---|
| `AcpAgentAdapter.clearUnavailableAgents()` is a no-op kept for "interface compatibility" | `src/agents/acp/adapter.ts:1093-1097` |
| `AgentRegistry.resetStoryState()` delegates to the no-op above | `src/agents/registry.ts:121-125` |
| `onBeforeStory: () => registry.resetStoryState()` in runner — always calls the no-op | `src/execution/runner.ts:179` |
| Stale comments referencing `_unavailableAgents` as if it still exists | `src/execution/runner-execution.ts:50`, `src/execution/executor-types.ts:51` |
| `scripts/codemods/agent-manager-migration.ts` should exist per Phase 3 AC; doesn't | — |

Recommended: delete `resetStoryState` + `clearUnavailableAgents` (one PR, ~30 lines) since `agentManager.reset()` is the real per-story reset now.

### Silent-failure risks

1. **Zod `.strip()` drops legacy config keys.** The Phase 6 AC promises a validation error; actual behaviour is silent acceptance. See Phase 6 findings.
2. **`costUsd` dropped on the way to metrics.** `AgentFallbackRecord.costUsd` → `AgentFallbackHop` has no such field → never aggregated. #519's cost-visibility promise quietly fails.
3. **`protocol` narrowed to `z.literal("acp")`.** Any config that still carries `agent.protocol: "cli"` will fail Zod with `expected "acp"` rather than a pathway-specific message. Low-impact but a divergence from the spec (`z.enum(["acp", "cli"])`).
4. **Rate-limit backoff is uncancellable.** `_agentManagerDeps.sleep` in `src/agents/manager.ts:200` can't be interrupted; an aborting run will wait up to 14s.
5. **`completeWithFallback` uses a sentinel `{} as ContextBundle`** at `src/agents/manager.ts:293` to satisfy the `!bundle` guard in `shouldSwap`. Works, but is a code smell — consider a second parameter or a `shouldSwap` overload that takes an `opts.skipBundleCheck` instead of casting.
6. **`onSwapExhausted` event only fires when `hopsSoFar > 0`** (`src/agents/manager.ts:203-205`). If the primary agent fails and there's no candidate at all, no event fires. Spec doesn't mandate emission in that case, but it's an asymmetry worth documenting.

### Test coverage

| Coverage | Present | Notes |
|:---|:---|:---|
| `AgentManager` unit — core | `test/unit/agents/manager.test.ts` (6.7K) | Covers `getDefault`, reset, event emission. |
| `AgentManager` — credentials (#518) | `test/unit/agents/manager-credentials.test.ts` (3.1K) | |
| `AgentManager` — swap loop | `test/unit/agents/manager-swap-loop.test.ts` (7.5K) | Covers executeHop, no-candidate, multi-hop, rate-limit backoff. |
| `AgentManager` — completeWithFallback | `test/unit/agents/manager-complete.test.ts` (2.7K) | |
| `resolveDefaultAgent` | `test/unit/agents/resolve-default-agent.test.ts` | |
| Phase 5 structural invariants | `test/unit/agents/phase5-invariants.test.ts` | Mostly grep-based assertions. |
| Phase 6 structural invariants | `test/unit/config/phase6-invariants.test.ts` | Asserts absence of legacy imports and schema fields. Does NOT assert that a pre-migration config **fails** — which is why the silent-strip regression exists. |
| Phase 4 adapter cleanup | `test/unit/agents/adapter-cleanup.test.ts` | String-absence checks only. |
| Integration — agent swap | `test/integration/execution/agent-swap.test.ts` (14K) | Exercises `runWithFallback` via execution stage with a mock registry. |
| Missing | `test/unit/config/loader-migration.test.ts` | Was specified in Phase 2 AC; file does not exist (deleted with shim in Phase 6). |
| Missing | Phase-6 "legacy config rejected" test | Not present; would catch the silent-strip regression. |
| Missing | `RunMetrics.fallback` aggregation tests | No code to test. |

### Docs alignment

- ADR-012 Phase 6 ACs check `[x]` for "CHANGELOG updated" and "docs/architecture/conventions.md and .claude/rules/config-patterns.md updated". Grep shows neither `conventions.md` nor `.claude/rules/config-patterns.md` contains `ADR-012`, `agent.default`, or a migration note. **Doc-reality gap.**
- CHANGELOG entry says "Loading a legacy config now fails Zod validation." — factually incorrect.
- Spec §"File Surface" lists `test/unit/agents/manager.test.ts` and `test/integration/agents/manager-fallback.test.ts`. The integration path lives at `test/integration/execution/agent-swap.test.ts` instead. Minor path drift; functionally equivalent.
- `docs/specs/SPEC-agent-manager-integration.md` §"Phased Implementation Detail" still has `[ ]` (unchecked) ACs for Phases 2–6 — ADR checkboxes advanced, spec did not. Either update the spec or fold it into the ADR as final.
- `docs/specs/SPEC-per-agent-model-map.md` still references `AllAgentsUnavailableError` as a live contract (lines 244, 323, 342) — should be marked superseded by ADR-012.

## Recommendations

**Must-fix before claiming #519 / Phase 6 closed:**

1. Add pre-parse legacy-key detection in `src/config/loader.ts` (or switch top-level schema to `.strict()` with a migration-message refiner) so loading `autoMode.defaultAgent` / `autoMode.fallbackOrder` / `context.v2.fallback` throws a `NaxError` pointing at ADR-012. Add a regression test. Resolves the Phase 6 AC gap and the dogfood silent-revert risk.
2. Fix CHANGELOG entry to match actual behaviour (or, preferably, fix #1 so the entry becomes accurate).
3. Thread `costUsd` end-to-end: add to `AgentFallbackHop`, preserve in `execution.ts:302-310`, aggregate at run completion. Close #519 honestly.
4. Add `RunMetrics.fallback: { totalHops, perPair, exhaustedStories, totalWastedCostUsd }` and populate in `run-completion.ts`.

**Should-fix:**

5. Update `docs/architecture/conventions.md` and `.claude/rules/config-patterns.md` with the canonical `config.agent` shape and link to ADR-012 — the ADR checkbox is ticked but the docs aren't updated.
6. Delete `AcpAgentAdapter.clearUnavailableAgents`, `AgentRegistry.resetStoryState`, and `onBeforeStory: registry.resetStoryState()` — dead post-Phase-4 code kept only for "interface compatibility".
7. Refresh stale comments in `src/execution/runner-execution.ts:50` and `src/execution/executor-types.ts:51` that still reference `_unavailableAgents`.
8. Normalize the dual-accessor pattern: pick `ctx.agentManager?.getDefault() ?? resolveDefaultAgent(config)` everywhere, and remove the hardcoded `?? "claude"` fallbacks in `src/pipeline/stages/*.ts`.

**Nice-to-have:**

9. Extract the 86-line `executeHop` closure in `src/pipeline/stages/execution.ts:188-273` into a named helper to match the repo's ≤30-line function guideline.
10. Replace the `{} as ContextBundle` sentinel in `src/agents/manager.ts:293` with an explicit `{ skipBundleCheck: true }` option to `shouldSwap`.
11. Make rate-limit backoff cancellable (`Promise.race` vs. an `AbortSignal`) to comply with `.claude/rules/forbidden-patterns.md` on uncancellable `Bun.sleep`.
12. If follow-up #577 / #578 exist for aggregates or credential-pre-flight surfacing, link them from the ADR's "Phase 5 follow-ups" section so the doc-vs-code drift is at least traceable.
13. Recover the codemod artefact (Phase 3 AC) or remove the AC from the ADR. Either is fine; the discrepancy is what matters.

---

## Resolution log

| Finding | PR | Status |
|:---|:---|:---|
| #1 Phase 6 silent-strip regression | #579 | ✅ Fixed — `rejectLegacyAgentKeys()` guard in `src/config/loader.ts` |
| #2 `costUsd` dropped on `AgentFallbackHop` | #580 | ✅ Fixed — field added to `AgentFallbackHop`; preserved in `src/pipeline/stages/execution.ts` |
| #3 `RunMetrics.fallback` aggregates never surfaced | #580 | ✅ Fixed — `deriveRunFallbackAggregates` in `src/metrics/aggregator.ts`; surfaced on `run:completed` event and saved `RunMetrics` |
| #4 Doc-reality gap (`conventions.md` / `config-patterns.md`) | PR-3 (this change) | ✅ Fixed — new §5 in `conventions.md`; new "Agent Config Shape (ADR-012)" in `config-patterns.md`; `CLAUDE.md` / `.nax/context.md` LLM-fallback rule updated; `SPEC-agent-manager-integration.md` marked shipped; `SPEC-per-agent-model-map.md` marked partially superseded |
| Dead-code cleanup (`clearUnavailableAgents` / `resetStoryState` / `onBeforeStory` hook) | PR-3 (this change) | ✅ Fixed — plumbing deleted across `src/agents/acp/adapter.ts`, `src/agents/registry.ts`, `src/execution/runner.ts`, `src/execution/runner-execution.ts`, `src/execution/executor-types.ts`, `src/execution/unified-executor.ts` (-37 lines) |

