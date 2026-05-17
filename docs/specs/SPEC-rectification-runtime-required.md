# SPEC: Remove Legacy keepOpen Path from Rectification

## Summary

Two rectification subsystems — `src/verification/rectification-loop.ts` and `src/tdd/rectification-gate.ts` — each contain a legacy `else` branch that dispatches via `agentManager.run({ keepOpen })` when no `NaxRuntime` is provided. This path bypasses `agentManager.runAsSession()`, so no `SessionTurnDispatchEvent` is emitted, leaving those rectification attempts invisible to the prompt auditor and cost aggregator. The fix threads `NaxRuntime` through the two callers that omit it (`rectify.ts` and `run-regression.ts`), makes `runtime` required in both rectification interfaces, and deletes the legacy branches.

## Motivation

`agentManager.run()` → `_runHop` → `createSessionRunHop` → `sessionManager.sendPrompt()` bypasses the dispatch middleware layer entirely. No `SessionTurnDispatchEvent` means no prompt audit record and no cost entry in `CostAggregator`.

The affected callers and their current status:

| Caller | Passes `runtime`? | Legacy branch hit? |
|--------|------------------|--------------------|
| `src/pipeline/stages/rectify.ts` | No | Every rectify-stage run |
| `src/execution/lifecycle/run-regression.ts` | No | Every post-run regression rectification |
| `src/tdd/orchestrator.ts` → `runFullSuiteGate` | Yes (line 299) | Never — already on modern path |

The TDD path already works correctly. Only the two pipeline callers need to be fixed.

## Design

### Approach

Thread `NaxRuntime` from existing context objects — both callers already have runtime available:
- `rectify.ts`: `ctx` extends `DispatchContext` which includes `runtime: NaxRuntime`
- `run-completion.ts`: `RunCompletionOptions extends DispatchContext`, so `options.runtime` exists

No new types, no new abstractions. The change is purely threading + deletion.

### Interface changes

**`RectificationLoopOptions` in `src/verification/rectification-loop.ts`:**

```typescript
// Before
sessionManager?: import("../session").ISessionManager;
sessionId?: string;
runtime?: import("../runtime").NaxRuntime;

// After — sessionManager removed (superseded by runtime.sessionManager)
sessionId?: string;   // kept: caller-provided nax session ID for G5 bindHandle
runtime: import("../runtime").NaxRuntime;  // now required
```

**`runFullSuiteGate` and private `runRectificationLoop` in `src/tdd/rectification-gate.ts`:**

```typescript
// Before
sessionManager?: import("../session").ISessionManager,
sessionId?: string,
runtime?: import("../runtime").NaxRuntime,

// After
sessionId?: string,   // kept: same reason as above
runtime: import("../runtime").NaxRuntime,  // now required; sessionManager param removed
```

**`DeferredRegressionOptions` in `src/execution/lifecycle/run-regression.ts`:**

```typescript
export interface DeferredRegressionOptions {
  config: NaxConfig;
  prd: PRD;
  workdir: string;
  runtime: import("../../runtime").NaxRuntime;  // added; agentManager removed (use runtime.agentManager)
}
```

### Legacy branch deletion

Both files contain an `else` branch that becomes dead code once `runtime` is required:

```typescript
// DELETE from rectification-loop.ts ~line 402 and rectification-gate.ts ~line 384
} else {
  // Legacy keepOpen path — used when no runtime is available (standalone callers).
  agentResult = await agentManager.run({
    runOptions: { ...runOptions, keepOpen: !isLastAttempt },
  });
}
```

The `if (runtime)` check that precedes this branch also becomes unconditional — the entire `while (true)` transport-retry block runs without a wrapping `if`.

### G5 bindHandle update

After removing `sessionManager?`, the G5 audit binding switches to `runtime.sessionManager`:

```typescript
// Before
if (sessionManager && sessionId && agentResult.protocolIds) {
  sessionManager.bindHandle(sessionId, rectificationSessionName, agentResult.protocolIds);
}

// After — sessionManager guard removed; runtime.sessionManager used directly
if (sessionId && agentResult.protocolIds) {
  try {
    runtime.sessionManager.bindHandle(sessionId, rectificationSessionName, agentResult.protocolIds);
  } catch {
    // Session may not exist in manager (e.g. v2 context disabled) — ignore.
  }
}
```

Apply the same update to `rectification-gate.ts` (G5 bindHandle at ~line 393).

### `finally` guard simplification

Both files guard session cleanup with `if (heldHandle && runtime)`. Once `runtime` is required the runtime guard is redundant:

```typescript
// Before
if (heldHandle && runtime) {

// After
if (heldHandle) {
```

### `keepOpen` is NOT removed

`AgentRunOptions.keepOpen` remains. It is still used by:
- `src/pipeline/stages/execution.ts:183` — holds the implementer session open for downstream review/rectification
- `src/tdd/session-runner.ts:233` — holds the implementer session open for TDD gate rectification
- `src/runtime/session-run-hop.ts:111` — reads `keepOpen` to decide whether to close the session after a run

Only the two `else` branches in the rectification files are deleted. The `heldHandle` pattern replaces `keepOpen` for session continuity within rectification loops.

### Failure handling

No new failure modes introduced. The modern `agentManager.runAsSession()` path is already the production path for TDD runs and has its own transport-retry loop for `QUEUE_DISCONNECTED_BEFORE_COMPLETION`. Deleting the legacy branch does not alter error propagation.

## Stories

### US-001: Thread `runtime` through the two broken callers

**Depends on:** none

Update the three files that are the dispatch source for the two broken callers:

1. **`src/pipeline/stages/rectify.ts`** — `_rectifyDeps.runRectificationLoop` wrapper: add `runtime: ctx.runtime`; remove `sessionManager: ctx.sessionManager` (field being dropped from interface). `sessionId: ctx.sessionId` stays.

2. **`src/execution/lifecycle/run-regression.ts`** — `DeferredRegressionOptions`: add `runtime: import("../../runtime").NaxRuntime`; remove `agentManager` (read it from `runtime.agentManager` inside the function instead). `runDeferredRegression`: destructure `runtime` from `options`; replace `agentManager` reads with `runtime.agentManager`; pass `runtime` into the `runRectificationLoop` call.

3. **`src/execution/lifecycle/run-completion.ts`** — `runDeferredRegression` call: replace `agentManager: options.agentManager` with `runtime: options.runtime`.

**Context Files:**
- `src/pipeline/stages/rectify.ts` — `_rectifyDeps` wrapper at ~line 141, `runRectificationLoop` call at ~line 146
- `src/execution/lifecycle/run-regression.ts` — `DeferredRegressionOptions` at ~line 31, `runRectificationLoop` call at ~line 323
- `src/execution/lifecycle/run-completion.ts` — `runDeferredRegression` call at ~line 145; `RunCompletionOptions extends DispatchContext` (runtime source)
- `src/runtime/dispatch-context.ts` — confirms `DispatchContext.runtime: NaxRuntime`
- `src/verification/rectification-loop.ts` — `RectificationLoopOptions` (interface being updated in US-002; read as reference)

**Acceptance Criteria:**
1. `_rectifyDeps.runRectificationLoop` passes `runtime: ctx.runtime` and does not pass `sessionManager`
2. `_rectifyDeps.runRectificationLoop` continues to pass `sessionId: ctx.sessionId`
3. `DeferredRegressionOptions` includes `runtime: NaxRuntime` as a required field and does not have an `agentManager` field
4. `runDeferredRegression` reads `agentManager` from `runtime.agentManager`, not from `options` directly
5. The `runRectificationLoop` call inside `runDeferredRegression` includes `runtime` in its options object
6. The `runDeferredRegression` call in `run-completion.ts` passes `runtime: options.runtime` and does not pass `agentManager`

---

### US-002: Remove legacy branch from `rectification-loop.ts`, make `runtime` required

**Depends on:** US-001

Surgery on `src/verification/rectification-loop.ts`:

1. Remove `sessionManager?: ISessionManager` from `RectificationLoopOptions`
2. Change `runtime?: NaxRuntime` to `runtime: NaxRuntime` in `RectificationLoopOptions`
3. Remove `sessionManager` from the destructure at ~line 197
4. Delete the `else` branch at ~line 402–407 (the legacy `agentManager.run({ keepOpen })` call)
5. Remove the `if (runtime)` wrapper around the `while (true)` transport-retry block — the block becomes unconditional (the `if` check is gone, the `while (true)` body remains intact)
6. Update G5 bindHandle at ~line 413: remove `sessionManager &&` guard; replace `sessionManager.bindHandle(...)` with `runtime.sessionManager.bindHandle(...)`
7. Update `finally` guard at ~line 532: `if (heldHandle && runtime)` → `if (heldHandle)`

**Context Files:**
- `src/verification/rectification-loop.ts` — full file; key mutation points at lines 50–86 (interface), 197–200 (destructure), 333–407 (if/else block), 413–418 (G5 bindHandle), 532–536 (finally guard)
- `test/unit/verification/rectification-loop.test.ts` — update to pass `runtime: makeTestRuntime()` in all `runRectificationLoop` call sites; add `afterEach` teardown calling `runtime.close()`
- `test/unit/verification/rectification-loop-escalation.test.ts` — same runtime threading update
- `test/helpers/runtime.ts` — `makeTestRuntime()` reference
- `test/helpers/index.ts` — `makeTestRuntime` export

**Acceptance Criteria:**
1. `RectificationLoopOptions` does not have a `sessionManager` field
2. `RectificationLoopOptions.runtime` has type `NaxRuntime` (non-optional)
3. When `runRectificationLoop` is called, `agentManager.runAsSession()` is invoked (not `agentManager.run()`)
4. When `runRectificationLoop` completes an attempt with `agentResult.protocolIds` set and `sessionId` provided, `runtime.sessionManager.bindHandle(sessionId, rectificationSessionName, protocolIds)` is called
5. When `runRectificationLoop` completes an attempt with `agentResult.protocolIds` set but no `sessionId`, `runtime.sessionManager.bindHandle` is not called
6. When the retry loop exits (success or exhausted), `runtime.sessionManager.closeSession(heldHandle)` is called if a `heldHandle` was opened
7. When the retry loop exits and no `heldHandle` was opened, `runtime.sessionManager.closeSession` is not called

---

### US-003: Remove legacy branch from `rectification-gate.ts`, make `runtime` required

**Depends on:** US-001  
**Parallel with:** US-002

Surgery on `src/tdd/rectification-gate.ts`:

1. Remove `sessionManager?: ISessionManager` from `runFullSuiteGate` parameter list (~line 92)
2. Change `runtime?: NaxRuntime` to `runtime: NaxRuntime` in `runFullSuiteGate` parameter list (~line 94)
3. Remove `sessionManager?: ISessionManager` from private `runRectificationLoop` parameter list (~line 241)
4. Change `runtime?: NaxRuntime` to `runtime: NaxRuntime` in private `runRectificationLoop` parameter list (~line 243)
5. Update both internal `runRectificationLoop` call sites in `runFullSuiteGate` (~lines 155–157 and 185–187): remove `sessionManager` argument; `runtime` and `sessionId` arguments stay
6. In `src/tdd/orchestrator.ts` at ~line 297, remove `implementerBinding?.sessionManager` from the `runFullSuiteGate` call; `implementerBinding?.sessionId` and `runtime` shift up one position
7. Delete the `else` branch at ~line 384–389 (legacy `agentManager.run({ keepOpen })`)
8. Remove the `if (runtime)` wrapper — the `while (transportRetries <= maxTransportRetries)` block becomes unconditional
9. Update G5 bindHandle at ~line 393: remove `sessionManager &&` guard; replace `sessionManager.bindHandle(...)` with `runtime.sessionManager.bindHandle(...)`
10. Update `finally` guard at ~line 478: `if (heldHandle && runtime)` → `if (heldHandle)`

**Context Files:**
- `src/tdd/rectification-gate.ts` — full file; key mutation points at lines 82–95 (`runFullSuiteGate` signature), 140–188 (call sites), 226–244 (private function signature), 316–389 (if/else block), 393–398 (G5 bindHandle), 478–482 (finally guard)
- `src/tdd/orchestrator.ts` — `runFullSuiteGate` call at ~line 287; remove `implementerBinding?.sessionManager` argument (step 6 above)
- `test/unit/tdd/rectification-gate.test.ts` — update to pass `runtime: makeTestRuntime()`; add `afterEach` teardown
- `test/unit/tdd/rectification-gate-session.test.ts` — same runtime threading update
- `test/helpers/runtime.ts` — `makeTestRuntime()` reference

**Acceptance Criteria:**
1. `runFullSuiteGate` does not have a `sessionManager` parameter
2. `runFullSuiteGate` `runtime` parameter is non-optional (`NaxRuntime`, not `NaxRuntime | undefined`)
3. Private `runRectificationLoop` does not have a `sessionManager` parameter
4. Private `runRectificationLoop` `runtime` parameter is non-optional
5. When private `runRectificationLoop` is called, `agentManager.runAsSession()` is invoked (not `agentManager.run()`)
6. When private `runRectificationLoop` completes an attempt with `rectifyResult.protocolIds` set and `sessionId` provided, `runtime.sessionManager.bindHandle(sessionId, rectificationSessionName, protocolIds)` is called
7. When the retry loop exits, `runtime.sessionManager.closeSession(heldHandle)` is called if a `heldHandle` was opened
8. `src/tdd/orchestrator.ts` call to `runFullSuiteGate` compiles without passing `sessionManager` (the argument is gone)

---

### Context Files (shared across all stories)

- `src/agents/types.ts` — `AgentRunOptions.keepOpen` field (read-only: confirm it stays, not removed)
- `src/runtime/dispatch-context.ts` — `DispatchContext` definition confirming `runtime: NaxRuntime` is already present on `PipelineContext` and `RunCompletionOptions`
- `docs/architecture/agent-adapters.md` §14 — permission resolution; confirm `resolvePermissions` wiring unchanged
- `test/helpers/runtime.ts` — `makeTestRuntime()` and `makeMockRuntime()` implementations
