# Review (Synthesis): ADR-018 Runtime Layering + ADR-019 Session Ownership Exit Criteria

**Date:** 2026-04-27
**Project under test:** `@nathapp/nax`
**Scope:** [docs/adr/ADR-018-runtime-layering-with-session-runners.md](../adr/ADR-018-runtime-layering-with-session-runners.md), [docs/adr/ADR-019-adapter-primitives-and-session-ownership.md](../adr/ADR-019-adapter-primitives-and-session-ownership.md)
**Related issues:** #688, #689, #690, #691, #692, #693, #706
**Prior review:** [2026-04-27-adr-018-019-runtime-layering-review.md](./2026-04-27-adr-018-019-runtime-layering-review.md)
**Status:** Implementation is test-green (`bun run typecheck`/`lint`/`test` all pass). Several exit criteria are **not** met.

This document confirms the prior agent's four findings, and adds **five** further mismatches between the live code, ADR-018 §Wave 2/3, and ADR-019 §5.

---

## Confirmed prior findings

The previous reviewer's evidence pointers were verified line-for-line. Summary, with my corroboration:

| # | Finding | Severity | Verified? |
|:--|:--|:--|:--|
| 1 | `callOp()` for `kind:"run"` calls [`sessionManager.runInSession`](../../src/session/manager.ts#L552-L597) directly instead of `agentManager.runWithFallback` + `buildHopCallback` (ADR-019 §5) | **High** | ✔ — see [src/operations/call.ts:38-58](../../src/operations/call.ts#L38-L58); ADR-019 sketch is at [ADR-019 §5 lines 442-471](../adr/ADR-019-adapter-primitives-and-session-ownership.md#L442-L471) |
| 2 | `keepOpen:` / `sessionHandle:` retirement still has live call paths in `src/review/`, `src/verification/`, `src/tdd/`, `src/pipeline/stages/autofix.ts` | **High** | ✔ — [src/review/semantic.ts:548,586](../../src/review/semantic.ts#L548), [src/review/adversarial.ts:318,359](../../src/review/adversarial.ts#L318), [src/verification/rectification-loop.ts:296](../../src/verification/rectification-loop.ts#L296), [src/tdd/rectification-gate.ts:303](../../src/tdd/rectification-gate.ts#L303), [src/tdd/session-runner.ts:211](../../src/tdd/session-runner.ts#L211), [src/pipeline/stages/autofix.ts:558](../../src/pipeline/stages/autofix.ts#L558), [src/pipeline/stages/autofix-adversarial.ts:138](../../src/pipeline/stages/autofix-adversarial.ts#L138). Tracking-doc claim "Zero `keepOpen: true` / `sessionHandle:` usages in `src/`" at [phase-e plan line 1887](../superpowers/plans/2026-04-26-adr-018-wave-3-phase-e.md#L1887) is incorrect. |
| 3 | `buildHopCallback()` flattens every `runAsSession` failure into `availability/fail-adapter-error`, dropping `SessionFailureError` typed-failure routing | **Medium** | ✔ — compare [src/operations/build-hop-callback.ts:163-181](../../src/operations/build-hop-callback.ts#L163-L181) (always emits `availability/fail-adapter-error`) with [src/runtime/session-run-hop.ts:67-82](../../src/runtime/session-run-hop.ts#L67-L82) (preserves `SessionFailureError.adapterFailure` and rate-limit detection) |
| 4 | Semantic-review debate uses unsafe placeholder `sessionManager` and `signal` while [src/debate/types.ts:11,14](../../src/debate/types.ts#L11) still admits `sessionMode:"stateful"` and `mode:"hybrid"` for the review stage | **Medium** | ✔ — see synthetic runtime in [src/review/semantic.ts:316,331](../../src/review/semantic.ts#L316-L331). No runtime guard rejects stateful/hybrid review. |

The ADR-018 / ADR-019 picture below is the prior review with these four points incorporated; the additions in §New findings are mine.

---

## New findings

### Finding 5 — `callOp` run-path bypasses the Wave-2 middleware chain

**Severity:** High

**Summary**

ADR-018 §3 and Gap-5 (Resolution G) make the middleware chain (`audit`, `cost`, `cancellation`, `logging`) the structural backbone for observability:

> **Session-internal calls covered by construction** — ADR-013 Phase 5 locked down direct adapter calls; everything flows through `IAgentManager`. `SessionManager.runInSession(id, manager, req)` therefore passes through the same middleware chain.
> — [docs/adr/ADR-018-gap-review.md:303-306](../adr/ADR-018-gap-review.md#L303-L306)

This is no longer true for `kind:"run"` ops dispatched through `callOp`.

**Evidence**

- Middleware is wired into the `AgentManager` only — see [src/runtime/index.ts:83-107](../../src/runtime/index.ts#L83-L107). The chain is passed to `createAgentManager`, never to `sessionManager`.
- `callOp` for `kind:"run"` calls `sessionManager.runInSession(name, prompt, opts)` (the **Phase B prompt form**, [src/session/manager.ts:558-595](../../src/session/manager.ts#L558-L595)).
- That overload calls `sessionManager.sendPrompt(handle, prompt, …)` → `adapter.sendTurn(...)` directly. Grep `src/session/manager.ts` for `middleware` — zero hits.
- Compare with `agentManager.runAsSession(...)` in [src/agents/manager.ts:440-472](../../src/agents/manager.ts#L440-L472), where `runBefore` / `runAfter` / `runOnError` are explicitly invoked around the dispatch.

**Why it matters**

Every `kind:"run"` op currently shipped — `acceptance-fix`, `acceptance-fix-tests`, `acceptance-diagnose`, `semantic-review` (run-form callers), `adversarial-review` (run-form callers), `rectify` — silently misses:

- **Audit** — no entry written to `.nax/audit/<runId>.jsonl` for these calls. Wave-2 exit criterion "PromptAuditor flushes to `.nax/audit/<runId>.jsonl` on `runtime.close()`" still flushes, but the run-op records never enter the buffer in the first place.
- **Cost** — `CostAggregator.snapshot()` will not reflect these calls. Wave-2 exit criterion "CostAggregator.snapshot() reflects all calls including nested and session-internal calls" is **false** for callOp run-path ops.
- **Budget enforcement** — the budget middleware (Wave 2 §6 OQ resolution) cannot abort these calls.
- **Cancellation guard** — the `cancellation` middleware that checks `signal.aborted` before terminal dispatch is skipped.
- **Logging** — structured per-call log entries are skipped.

This couples to Finding 1: even fixing `callOp` to use `runWithFallback` + `buildHopCallback` is not enough on its own — `buildHopCallback` itself uses `agentManager.runAsSession` ([src/operations/build-hop-callback.ts:155](../../src/operations/build-hop-callback.ts#L155)), which DOES traverse the middleware chain. So fixing Finding 1 transitively fixes Finding 5. They are the same root cause: `callOp` route divergence from ADR-019 §5.

**Recommended follow-up**

Roll into the Finding 1 remediation. After `callOp` routes through `runWithFallback` + `buildHopCallback`, add a regression test that asserts:

1. `auditMiddleware` writes one entry per `kind:"run"` `callOp` call.
2. `costAggregator.snapshot()` totals match the sum of all `callOp(... kind:"run" ...)` results.

Without these, the middleware chain can silently drift again.

---

### Finding 6 — `noFallback` flag on `RunOperation` is dead at runtime

**Severity:** Medium

**Summary**

[src/operations/types.ts:54](../../src/operations/types.ts#L54) declares `readonly noFallback?: boolean` on `RunOperation<I,O,C>`. ADR-018 §5.3 ("TDD orchestrator") explicitly relies on this flag:

> TDD ops set `noFallback: true` when invoking `callOp` (via `sessionOverride` or a dedicated field on input) so `SingleSessionRunner` wraps the adapter without fallback. Preserves today's `fallbacks: []` invariant at the type level.

**Evidence**

- The flag is declared but never read by `callOp` — `rtk grep -n "noFallback" src/operations/call.ts` returns nothing.
- Today the question is moot: `callOp` calls `runInSession` directly, so no fallback can occur regardless. But once Finding 1 is fixed, the flag must be honored — otherwise TDD ops migrated through `callOp` would silently start participating in cross-agent fallback, regressing the established `fallbacks: []` invariant.

**Why it matters**

This is a latent regression: it is harmless today only because Finding 1 makes the fallback path unreachable from `callOp`. As soon as Finding 1 is corrected, TDD ops will gain unintended fallback behavior unless `callOp` branches on `op.noFallback`.

**Recommended follow-up**

Bundle with the Finding 1 fix: when `callOp` constructs the `runWithFallback` request, branch on `op.noFallback` to either pass the AgentManager or wrap the adapter with `wrapAdapterAsManager(...)` (mirroring ADR-018 §5.2's sketch). Add a test that confirms `noFallback:true` ops produce zero fallback hops even when an availability failure is injected on the primary agent.

---

### Finding 7 — `AgentAdapter` surface still exceeds the ADR-019 Phase D goal

**Severity:** Low

**Summary**

ADR-019 Phase D ([issue #706](https://github.com/nathapp-io/nax/issues/706)) and the issue's exit criteria say the adapter surface becomes `{ openSession, sendTurn, closeSession, complete, plan, decompose }`, with `plan`/`decompose` removed in Wave 3.5. After Wave 3.5 the steady-state target should be **four** methods.

In [src/agents/types.ts:365-442](../../src/agents/types.ts#L365-L442) the live shape carries:

- `openSession`, `sendTurn`, `closeSession(handle)` — new (good)
- `complete` — kept (good)
- `closePhysicalSession(handle, workdir, options?)` — old form, marked "replaced by closeSession" but still present
- `deriveSessionName(descriptor)` — used by pipeline stages to derive ACP names (peer to `SessionManager.nameFor`)
- optional `runInteractive` (TUI PTY mode) — orthogonal, fine

**Why it matters**

Two callers of `closePhysicalSession` remain (semantic.ts and adversarial.ts) — the same call sites flagged in Finding 2. `deriveSessionName` is invoked from a handful of pipeline stages and duplicates `SessionManager.nameFor`. Until both are excised, the adapter surface still publishes session-naming and session-closing concerns that ADR-019 says belong on `SessionManager`.

**Recommended follow-up**

After Finding 2 is resolved (review subsystem migrated to caller-managed `openSession + runAsSession + closeSession`), `closePhysicalSession` becomes deletable. `deriveSessionName` deletion is a separate small refactor — convert callers to `SessionManager.nameFor`.

---

### Finding 8 — ADR-019 "zero cross-imports" exit criterion is not strictly met

**Severity:** Low

**Summary**

[Issue #706](https://github.com/nathapp-io/nax/issues/706) lists "AgentManager and SessionManager have zero cross-imports (peer relationship)" as an exit criterion.

The runtime `src/agents/manager.ts` and `src/session/manager.ts` files are clean of each other. But the surrounding modules in each tree do cross:

- [src/agents/types.ts:13](../../src/agents/types.ts#L13) — `import type { ProtocolIds, SessionDescriptor } from "../session/types"` (load-bearing in `AgentRunOptions`)
- [src/agents/acp/adapter.ts:22](../../src/agents/acp/adapter.ts#L22) — `import type { ProtocolIds } from "../../session/types"`
- [src/agents/utils.ts:5](../../src/agents/utils.ts#L5) — `import { formatSessionName } from "../session/naming"` (value import)
- [src/session/manager.ts:13-14](../../src/session/manager.ts#L13-L14) — `import { NO_OP_INTERACTION_HANDLER } from "../agents"` and `import type { AgentAdapter, AgentResult, SessionHandle, TurnResult } from "..."`

**Why it matters**

The interpretation of "cross-imports" is the deciding factor. If "module-tree" is the unit, the exit criterion is met (manager-to-manager is clean). If "subsystem barrel" is the unit, it is not — `agents/utils.ts` imports a session **value** (`formatSessionName`) and `session/manager.ts` imports an `agents` value (`NO_OP_INTERACTION_HANDLER`). The pure-type imports of `ProtocolIds` / `SessionDescriptor` from `session/types` into `agents/types` are also a structural coupling: any change to `SessionDescriptor` ripples into the `AgentRunOptions` type contract.

**Recommended follow-up**

Either (a) move the small set of shared types (`SessionDescriptor`, `ProtocolIds`, `SessionHandle`, `TurnResult`) into a neutral package — e.g. `src/agents-session/` or `src/runtime/protocol-types.ts` — so neither tree depends on the other, or (b) narrow the wording in the issue's exit criterion to "no value-level cross-import in the manager call paths" and document the type-only links as expected.

---

### Finding 9 — `_deps.createManager` survives outside `src/runtime/`

**Severity:** Low

**Summary**

ADR-018 Wave 3.5 exit criterion ([issue #691](https://github.com/nathapp-io/nax/issues/691)) says:

> Zero `_deps.createManager` references outside `src/runtime/`

Live code:

- [src/cli/plan.ts:64](../../src/cli/plan.ts#L64) — `createManager: createAgentManager` inside `_planDeps`, used at lines 201, 248, 304, 590.

**Why it matters**

`src/cli/plan.ts` is a CLI entry point and a legitimate place to construct a manager directly today; the code itself is reasonable. The literal exit-criterion claim is what is incorrect. Either the CLI path warrants an explicit carve-out in the exit criterion, or `nax plan` should be migrated to construct via `createRuntime()` like the runner does.

**Recommended follow-up**

Pick one of:

1. Migrate `src/cli/plan.ts` to construct a runtime via `createRuntime()` (consistent with the rest of the CLI surface that no longer constructs managers).
2. Update the wording in the Wave-3.5 exit criterion to "outside `src/runtime/` and `src/cli/`" and document the carve-out.

---

## Overall exit-criteria assessment (synthesis)

### Met

- Wave 3.5 adapter `plan` / `decompose` deletion landed (no `planAs` / `decomposeAs` in `src/`)
- `DebateRunner` exists; old `DebateSession` entrypoint is gone; `runner-stateful.ts` / `runner-hybrid.ts` / `runner-plan.ts` use the new `openSession + runAsSession + closeSession` lifecycle
- `dialogue.ts` migration to caller-managed sessions is complete
- Wave 4 retry-loop unification (`RetryInput<TFailure,TResult>`) shipped
- Wave 5 `process.cwd()` audit complete — no non-CLI/non-`config/loader.ts` usages
- Wave 5 `SessionRole` template-literal tightening shipped (`debate-${string}`, `plan-hybrid-${number}`)
- `ISessionRunner` and `SingleSessionRunner` deletion complete (Phase C)
- `bun run typecheck`, `bun run lint`, `bun run test` all green

### Not fully met

- **Finding 1 (ADR-019 §5):** `callOp` run-path does not use `runWithFallback` + `buildHopCallback`. Architectural target unmet.
- **Finding 5 (Wave 2 §3 + Gap-5 G):** Middleware chain bypassed for `kind:"run"` ops dispatched via `callOp`. CostAggregator and PromptAuditor are not "all-call complete" as the Wave-2 exit criterion claims.
- **Finding 2 (Phase D / phase-e plan):** `keepOpen:` / `sessionHandle:` migration incomplete. Tracking-doc claim is wrong.
- **Finding 3 (regression risk in fallback policy):** `buildHopCallback` flattens typed failures — fallback policy will misclassify under load.
- **Finding 4 (review-debate config surface):** `sessionMode: "stateful"` / `mode: "hybrid"` accepted by the config surface but unsafe in the review-stage debate path.
- **Finding 6 (latent regression):** `op.noFallback` declared but unread; will silently regress TDD invariant once Finding 1 is fixed.
- **Finding 7 (Phase D adapter surface):** `closePhysicalSession` and `deriveSessionName` outlive their replacements.
- **Finding 8 (#706 exit criterion):** "Zero cross-imports" between AgentManager and SessionManager is met at the manager level but not at the subsystem level (type-only and small value imports remain).
- **Finding 9 (Wave 3.5 exit criterion):** `_deps.createManager` survives in `src/cli/plan.ts`.

---

## Suggested next steps

1. **Triage Findings 1+5+6 as one work item.** They are the same root cause (callOp run-path divergence from ADR-019 §5) with three observable symptoms: bypassed middleware, missing fallback, and dead `noFallback`. Fixing `callOp` to use `runWithFallback` + `buildHopCallback` resolves all three simultaneously. Add structural tests so the boundary cannot drift again.
2. **Decide on Finding 2.** Either complete the migration of the five remaining `keepOpen` / `sessionHandle` call sites in `src/review/`, `src/verification/`, `src/tdd/`, `src/pipeline/stages/autofix.ts`, or amend the Wave-3 phase-e tracking doc to remove the "zero usages" claim. Right now code and docs disagree.
3. **Fix Finding 3 in `buildHopCallback`.** Mirror `session-run-hop.ts`'s `SessionFailureError` handling so typed failures (rate-limit, availability, etc.) survive into the swap-policy decision.
4. **Decide Finding 4.** Either restrict review-stage debate at config validation time to `oneshot` / `panel`, or thread a real `sessionManager` + `signal` through the semantic-review debate path. The current synthetic-runtime placeholder is unsafe under hybrid/stateful review.
5. **Cleanup pass.** Findings 7, 8, 9 are individually small but together they make the "we shipped ADR-018+019" story honest. Either land the deletions or update the exit-criteria wording to match what shipped.

The implementation as a whole is in good shape — the bones are correct (DebateRunner, retry-loop unification, SingleSessionRunner deletion, Wave-5 lint guards) — but several exit criteria are claimed-met when they are not, and Findings 1+5+6 are real architectural debt that gates the soundness of the runtime model going forward.
