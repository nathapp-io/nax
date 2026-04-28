# ADR-020 Wave 1 — Typed Dispatch Events at Three Boundaries + `SessionRole` SSOT

> **Spec status:** Ready for implementation
> **Owning ADR:** [docs/adr/ADR-020-dispatch-boundary-ssot.md](../adr/ADR-020-dispatch-boundary-ssot.md) §D1, §D2, §D5, §D6
> **Closes:** [#773](https://github.com/nathapp-io/nax/issues/773); deletes the tactical patch from [docs/findings/2026-04-28-tdd-audit-naming-tactical.md](../findings/2026-04-28-tdd-audit-naming-tactical.md)
> **Estimated:** ~300 LOC source, ~250 LOC tests, single PR

---

## Goal

After this wave lands:

1. Every agent dispatch emits exactly one typed `DispatchEvent` from one of three concrete boundaries (`runAsSession`, `runTrackedSession`, `completeAs`). Envelope methods (`runAs`, `runWithFallback`) emit `OperationCompletedEvent` instead.
2. Audit and cost middleware are pure event subscribers — no `executeHop`/`sessionHandle`/`completeOptions` scraping anywhere.
3. `SessionRole` is a typed union; descriptor/handle/options/event consumers use the typed type. Drift like the acceptance `"acceptance"` vs `"acceptance-gen"` mismatch is a compile error.
4. Tactical `AgentRunOptions.sessionHint` field is deleted; the tactical patch's test (`test/integration/tdd/audit-naming.test.ts`) survives unchanged.

## Prerequisites

- Tactical patch from [docs/findings/2026-04-28-tdd-audit-naming-tactical.md](../findings/2026-04-28-tdd-audit-naming-tactical.md) merged (provides the `audit-naming.test.ts` regression test that locks in correctness across this wave).
- ADR-020 itself merged (this is the doc this wave implements).

## Architecture

```
                         ┌───────────────────────────────┐
                         │   DispatchEventBus (new)      │
                         │   live in NaxRuntime          │
                         └──────────────┬────────────────┘
                                        │ emit
       ┌────────────────────────────────┼────────────────────────────────┐
       │                                │                                │
┌──────▼──────────┐         ┌───────────▼──────────────┐      ┌──────────▼──────────┐
│ runAsSession    │         │ runTrackedSession        │      │ completeAs          │
│ (manager.ts)    │         │ (session/manager-run.ts) │      │ (manager.ts)        │
│ emits           │         │ emits                    │      │ emits               │
│ session-turn    │         │ session-turn             │      │ complete            │
└─────────────────┘         └──────────────────────────┘      └─────────────────────┘
                                        │
                                        │ subscribe
                  ┌─────────────────────┼─────────────────────┐
                  │                     │                     │
            ┌─────▼──────┐       ┌──────▼──────┐       ┌──────▼──────┐
            │ audit      │       │ cost        │       │ logging     │
            │ subscriber │       │ subscriber  │       │ subscriber  │
            └────────────┘       └─────────────┘       └─────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ runWithFallback (envelope) emits ONE OperationCompletedEvent at end:    │
│   { operation, agentChain, hopCount, fallbackTriggered, finalStatus }   │
│ Logging/metrics subscribe; audit/cost ignore.                           │
└──────────────────────────────────────────────────────────────────────────┘
```

Single-emission invariant: a logical TDD per-role dispatch goes through `runTrackedSession` (which emits) and then `manager.run` → `runAs` envelope (which does **not** emit). Single-session callOp goes through `runAs` → `executeHop` → `runAsSession` (which emits). One-shot calls go through `completeAs` (which emits). No path emits twice.

## Step-by-step implementation

### Step 1 — `SessionRole` SSOT

**New file: `src/runtime/session-role.ts`** (~25 LOC)

```typescript
/**
 * Canonical session role registry — SSOT for adapter-wiring.md Rule 2.
 * Promoting ADR-018 §9's template-literal union here so every consumer
 * (descriptor, handle, runOptions, completeOptions, DispatchEvent) shares
 * the same type. Free-form sessionRole strings are banned outside this
 * file; misspellings/legacy values become compile errors at the call site.
 */

export type CanonicalSessionRole =
  | "main"
  | "test-writer" | "implementer" | "verifier"
  | "diagnose" | "source-fix" | "test-fix"
  | "reviewer-semantic" | "reviewer-adversarial"
  | "plan" | "decompose"
  | "acceptance-gen" | "refine" | "fix-gen"
  | "auto" | "synthesis" | "judge";

export type SessionRole = CanonicalSessionRole | `debate-${string}`;

export const KNOWN_SESSION_ROLES: readonly CanonicalSessionRole[] = [
  "main",
  "test-writer", "implementer", "verifier",
  "diagnose", "source-fix", "test-fix",
  "reviewer-semantic", "reviewer-adversarial",
  "plan", "decompose",
  "acceptance-gen", "refine", "fix-gen",
  "auto", "synthesis", "judge",
] as const;

export function isSessionRole(s: string): s is SessionRole {
  if ((KNOWN_SESSION_ROLES as readonly string[]).includes(s)) return true;
  return s.startsWith("debate-") && s.length > 7;
}
```

Export from `src/runtime/index.ts` barrel.

### Step 2 — Typed event types

**New file: `src/runtime/dispatch-events.ts`** (~120 LOC)

```typescript
import type { PipelineStage } from "../pipeline/types";
import type { TokenUsage } from "../agents/types";
import type { SessionRole } from "./session-role";

/**
 * Fields every dispatch event carries, regardless of kind. New cross-cutting
 * fields (e.g. traceId, resolvedPermissions, packageId) go here once; both
 * variants and every subscriber pick them up via the compiler.
 */
export interface DispatchEventBase {
  readonly sessionName: string;
  readonly sessionRole: SessionRole;
  readonly prompt: string;
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly featureName?: string;
  readonly usage?: TokenUsage;
  readonly exactCostUsd?: number;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface SessionTurnDispatchEvent extends DispatchEventBase {
  readonly kind: "session-turn";
  readonly turn: number;
  readonly protocolIds: { sessionId?: string; turnId?: string };
  readonly origin: "runAsSession" | "runTrackedSession";
}

export interface CompleteDispatchEvent extends DispatchEventBase {
  readonly kind: "complete";
}

export type DispatchEvent = SessionTurnDispatchEvent | CompleteDispatchEvent;

export interface OperationCompletedEvent {
  readonly kind: "operation-completed";
  readonly operation: "run-with-fallback" | "complete-with-fallback";
  readonly agentChain: readonly string[];
  readonly hopCount: number;
  readonly fallbackTriggered: boolean;
  readonly totalElapsedMs: number;
  readonly totalCostUsd: number;        // sum of per-hop DispatchEvent.exactCostUsd
  readonly finalStatus: "ok" | "exhausted" | "cancelled" | "error";
  readonly storyId?: string;
  readonly stage: PipelineStage;
  readonly timestamp: number;
}

export type DispatchListener = (event: DispatchEvent) => void;
export type OperationCompletedListener = (event: OperationCompletedEvent) => void;

export interface IDispatchEventBus {
  onDispatch(listener: DispatchListener): () => void;
  onOperationCompleted(listener: OperationCompletedListener): () => void;
  emitDispatch(event: DispatchEvent): void;
  emitOperationCompleted(event: OperationCompletedEvent): void;
}

export class DispatchEventBus implements IDispatchEventBus {
  private readonly _dispatchListeners = new Set<DispatchListener>();
  private readonly _completedListeners = new Set<OperationCompletedListener>();

  onDispatch(l: DispatchListener) {
    this._dispatchListeners.add(l);
    return () => this._dispatchListeners.delete(l);
  }
  onOperationCompleted(l: OperationCompletedListener) {
    this._completedListeners.add(l);
    return () => this._completedListeners.delete(l);
  }
  emitDispatch(event: DispatchEvent) {
    for (const l of this._dispatchListeners) {
      try { l(event); }
      catch (err) {
        // Subscribers must not break the chain. Log and continue.
        getLogger().warn("dispatch-bus", "listener threw", { error: errorMessage(err) });
      }
    }
  }
  emitOperationCompleted(event: OperationCompletedEvent) {
    for (const l of this._completedListeners) {
      try { l(event); }
      catch (err) {
        getLogger().warn("dispatch-bus", "completion-listener threw", { error: errorMessage(err) });
      }
    }
  }
}
```

Wire into `NaxRuntime` (`src/runtime/index.ts`): add `readonly dispatchEvents: IDispatchEventBus` field, instantiate in `createRuntime`, expose via `runtime.dispatchEvents`.

### Step 3 — Tighten role-bearing types

| File | Change |
|:---|:---|
| `src/agents/types.ts` | `AgentRunOptions.sessionRole?: string` → `sessionRole?: SessionRole`. Same for `AgentCompleteOptions.sessionRole`. |
| `src/agents/types.ts` | `SessionHandle.role?: string` → `role: SessionRole` (required). All adapter `openSession` implementations already set it. |
| `src/session/types.ts` | `SessionDescriptor.role: string` → `role: SessionRole`. |
| `src/runtime/session-name.ts` | `SessionNameRequest.role?: string` → `role?: SessionRole`. |

Run typecheck after this step. Compile errors at every drift site (acceptance generator at `src/acceptance/generator.ts:181,472`, plus any other free-form `sessionRole: "..."` literals). Fix each in place — most are simple typos or legacy values that should match the registry.

**Concrete fix expected at acceptance-gen:** generator already passes `"acceptance-gen"` correctly, so the typecheck passes there. The drift is downstream — likely `formatSessionName` or `nameFor` is being called with a truncated role at some other site. Trace each compile error to the source.

### Step 4 — Emit from `runAsSession`

**File: `src/agents/manager.ts`** around line 442 (`runAsSession`).

After successful adapter return, before the existing middleware `runAfter` call (which gets removed in Step 7):

```typescript
const event: SessionTurnDispatchEvent = {
  kind: "session-turn",
  sessionName: handle.id,
  sessionRole: handle.role,
  prompt,
  agentName,
  stage: opts.pipelineStage,
  storyId: opts.storyId,
  featureName: opts.featureName,
  turn: result.internalRoundTrips ?? 0,
  protocolIds: result.protocolIds ?? {},
  origin: "runAsSession",
  usage: result.usage,
  exactCostUsd: result.exactCostUsd,
  durationMs: Date.now() - startedAt,
  timestamp: Date.now(),
};
this._runtime.dispatchEvents.emitDispatch(event);
```

Apply the same pattern in `onError` path with a separate `DispatchErrorEvent` if needed (or surface via existing logging — defer to taste; audit currently records errors via `recordError`, can be done via a separate event type if cleaner, otherwise keep in middleware error path).

### Step 5 — Emit from `runTrackedSession`

**File: `src/session/manager-run.ts`** around line 36–82.

The descriptor is already loaded at line 42. After `runner.run(injectedRequest)` returns successfully:

```typescript
const sessionName = state.nameFor({
  workdir: descriptor.workdir,
  featureName: descriptor.featureName,
  storyId: descriptor.storyId,
  role: descriptor.role,
});

const event: SessionTurnDispatchEvent = {
  kind: "session-turn",
  sessionName,
  sessionRole: descriptor.role,
  prompt: request.runOptions.prompt,
  agentName: request.runOptions.agentName ?? "claude",
  stage: request.runOptions.pipelineStage,
  storyId: descriptor.storyId,
  featureName: descriptor.featureName,
  turn: result.internalRoundTrips ?? 0,
  protocolIds: result.protocolIds ?? {},
  origin: "runTrackedSession",
  usage: result.usage,
  exactCostUsd: result.exactCostUsd,
  durationMs: Date.now() - startedAt,
  timestamp: Date.now(),
};
state.dispatchEvents.emitDispatch(event);
```

Threading: `SessionManagerState` (`src/session/manager-run.ts` top) gains `dispatchEvents: IDispatchEventBus`. `SessionManager` constructor receives it from `NaxRuntime`.

**Critical:** delete the tactical `sessionHint` field-write here. Wave 1's emission replaces it.

### Step 6 — Emit from `completeAs`

**File: `src/agents/manager.ts`** around line 388 (`completeAs`).

Compute `sessionName` from `formatSessionName({ workdir, featureName, storyId, role: opts.sessionRole, pipelineStage })` (already done by current audit middleware — move the call here).

```typescript
const event: CompleteDispatchEvent = {
  kind: "complete",
  sessionName: formatSessionName({ ... }),
  sessionRole: opts.sessionRole ?? "main",
  prompt,
  agentName,
  stage: opts.pipelineStage,
  storyId: opts.storyId,
  featureName: opts.featureName,
  usage: result.usage,
  exactCostUsd: result.exactCostUsd,
  durationMs: Date.now() - startedAt,
  timestamp: Date.now(),
};
this._runtime.dispatchEvents.emitDispatch(event);
```

### Step 7 — Strip middleware emission from envelopes; emit `OperationCompletedEvent`

**File: `src/agents/manager.ts`**.

In `runAs()` (line 395–440): remove `_middleware.runBefore` + `_middleware.runAfter` calls. They were the duplicate-emission source. Permission resolution (pre-chain) stays — still required.

In `runWithFallback()` (line 181–306): track agentChain, hopCount, fallbackTriggered, totalElapsedMs, totalCostUsd (sum of dispatch events emitted for this call's children — see below). At end (success or exhaustion), emit:

```typescript
this._runtime.dispatchEvents.emitOperationCompleted({
  kind: "operation-completed",
  operation: "run-with-fallback",
  agentChain,
  hopCount,
  fallbackTriggered: hopCount > 1,
  totalElapsedMs: Date.now() - startedAt,
  totalCostUsd: hopCosts.reduce((a, b) => a + b, 0),
  finalStatus: result ? "ok" : (signal.aborted ? "cancelled" : "exhausted"),
  storyId: request.runOptions?.storyId,
  stage: request.runOptions?.pipelineStage ?? "run",
  timestamp: Date.now(),
});
```

`hopCosts` is collected by subscribing to dispatch events for the call's lifetime. Implementation detail: a per-call `correlationId` on `runOptions` lets the envelope filter dispatch events by call. Or simpler: capture `result.exactCostUsd` from each hop directly.

Same treatment for `completeWithFallback`.

### Step 8 — Rewrite audit middleware as subscriber

**File: `src/runtime/middleware/audit.ts`** — full rewrite.

```typescript
import type { IPromptAuditor, PromptAuditEntry } from "../prompt-auditor";
import type { IDispatchEventBus, DispatchEvent } from "../dispatch-events";

export function attachAuditSubscriber(
  bus: IDispatchEventBus,
  auditor: IPromptAuditor,
  runId: string,
): () => void {
  return bus.onDispatch((event: DispatchEvent) => {
    const entry: PromptAuditEntry = {
      ts: event.timestamp,
      runId,
      agentName: event.agentName,
      stage: event.stage,
      storyId: event.storyId,
      permissionProfile: event.resolvedPermissions?.mode ?? "unknown",
      prompt: event.prompt,
      response: event.response ?? "",
      durationMs: event.durationMs,
      callType: event.kind === "session-turn" ? "run" : "complete",
      workdir: event.workdir,
      projectDir: event.projectDir,
      featureName: event.featureName,
      sessionName: event.sessionName,
      ...(event.kind === "session-turn" && {
        recordId: event.protocolIds.recordId,
        sessionId: event.protocolIds.sessionId,
        turn: event.turn,
      }),
    };
    auditor.record(entry);
  });
}
```

**Important:** `DispatchEvent` does not currently carry `response`, `workdir`, `projectDir`, `resolvedPermissions`. Add them to `DispatchEventBase` in Step 2 (resolved at the boundary that has them: `workdir`/`projectDir` from `opts`, `resolvedPermissions` from the pre-chain resolution, `response` from `result.output`). This was the gap that drove the original ad-hoc context sniffing — make it explicit fields on the event now.

Update `DispatchEventBase` in `src/runtime/dispatch-events.ts`:

```typescript
export interface DispatchEventBase {
  // ... existing fields ...
  readonly response: string;             // result.output
  readonly workdir?: string;
  readonly projectDir?: string;
  readonly resolvedPermissions: ResolvedPermissions;
}
```

Each emitter (Steps 4, 5, 6) populates these from data already in scope.

Wire `attachAuditSubscriber` into runtime construction (`src/runtime/index.ts` `createRuntime`); replace the existing `auditMiddleware(...)` registration.

**Delete:** `src/runtime/middleware/audit.ts:30` `executeHop` guard, `sessionNameFromCompleteOptions` helper (no scrape). Old `auditMiddleware(auditor, runId): AgentMiddleware` factory deleted.

### Step 9 — Rewrite cost middleware as subscriber

**File: `src/runtime/middleware/cost.ts`** — same pattern as audit.

```typescript
export function attachCostSubscriber(
  bus: IDispatchEventBus,
  aggregator: ICostAggregator,
  runId: string,
): () => void {
  const offDispatch = bus.onDispatch((event) => {
    aggregator.record({
      ts: event.timestamp,
      runId,
      agentName: event.agentName,
      stage: event.stage,
      storyId: event.storyId,
      callType: event.kind === "session-turn" ? "run" : "complete",
      sessionName: event.sessionName,
      sessionRole: event.sessionRole,
      usage: event.usage,
      exactCostUsd: event.exactCostUsd,
      durationMs: event.durationMs,
    });
  });
  const offCompleted = bus.onOperationCompleted((event) => {
    aggregator.recordOperationSummary({
      runId,
      operation: event.operation,
      hopCount: event.hopCount,
      fallbackTriggered: event.fallbackTriggered,
      totalCostUsd: event.totalCostUsd,
      totalElapsedMs: event.totalElapsedMs,
      finalStatus: event.finalStatus,
    });
  });
  return () => { offDispatch(); offCompleted(); };
}
```

Add `recordOperationSummary(...)` to `ICostAggregator` if not already present (separate from per-dispatch `record` so subscribers can distinguish).

**Delete:** `src/runtime/middleware/cost.ts:34` guard.

### Step 10 — Logging middleware as subscriber (optional but recommended)

**File: `src/runtime/middleware/logging.ts`** — same pattern, subscribes to both event types for structured JSONL logging.

### Step 11 — Delete tactical `sessionHint`

| File | Change |
|:---|:---|
| `src/agents/types.ts` | Remove `AgentRunOptions.sessionHint` field |
| `src/session/manager-run.ts` | Remove the tactical's `injectedRequest.runOptions.sessionHint` write (replaced by `emitDispatch` in Step 5) |
| `src/runtime/middleware/audit.ts` | The third-fallback line (already deleted in the rewrite) |
| `src/runtime/middleware/cost.ts` | Same |

Grep `sessionHint` returns zero hits.

### Step 12 — `MiddlewareContext` and chain cleanup

**File: `src/runtime/agent-middleware.ts`**.

`AgentMiddleware` interface stays for any non-event-driven concerns (cancellation translation, e.g.) but `MiddlewareContext` no longer needs to carry dispatch metadata. Audit/cost are no longer middleware — they're subscribers.

Remove from `MiddlewareContext`: any field added in earlier rounds purely for audit/cost scraping (e.g. `completeOptions`, `sessionHandle` if no remaining middleware reads them). Cancellation middleware likely still needs `signal`; keep that.

If after audit and cost are removed, no middleware remains, the chain itself can be deleted. Verify by greping for remaining `AgentMiddleware` implementations.

## Tests

### `test/unit/runtime/dispatch-events.test.ts` (new, ~150 LOC)

```typescript
test("DispatchEventBus emits to all subscribers", ...);
test("subscriber that throws does not break the chain", ...);
test("unsubscribe stops further deliveries", ...);
test("DispatchEventBase fields populated by all three boundaries", () => {
  // Stub adapter; instantiate runtime; subscribe; invoke each boundary;
  // assert event field-by-field for each.
});
```

### `test/unit/agents/manager-dispatch-emission.test.ts` (new, ~100 LOC)

Pure-function tests of each emission point:
- `runAsSession` emits exactly one `session-turn` event with `origin: "runAsSession"`
- `runTrackedSession` emits exactly one `session-turn` event with `origin: "runTrackedSession"`
- `completeAs` emits exactly one `complete` event
- `runWithFallback` over 2 hops emits two `session-turn` events (via `executeHop` → `runAsSession`) and one `OperationCompletedEvent` with `fallbackTriggered: true`
- `runAs` envelope alone (no executeHop) emits zero `DispatchEvent` and one `OperationCompletedEvent`

### `test/unit/runtime/middleware/audit.test.ts` (rewrite ~100 LOC)

Delete all guard-based cases. New cases:
- `attachAuditSubscriber` records one entry per emitted event
- session-turn event → entry has `callType: "run"`, `turn`, `protocolIds`
- complete event → entry has `callType: "complete"`
- subscriber unsubscribe stops recording

### `test/unit/runtime/middleware/cost.test.ts` (rewrite ~80 LOC)

Same shape as audit tests, plus a case for `OperationCompletedEvent` summary recording.

### `test/integration/tdd/audit-naming.test.ts` (existing — preserved unchanged)

The tactical patch's test passes both before and after Wave 1. It asserts the **outcome** (per-role audit filenames exist after a TDD run). Implementation underneath swaps from `sessionHint` to `DispatchEvent`; test stays green.

### `test/integration/acceptance/audit-naming.test.ts` (new, ~40 LOC)

Asserts acceptance-gen audit file is named `*-acceptance-gen-complete.txt`, not `*-acceptance-complete.txt`. This locks in the D6 role-drift fix.

### `test/unit/runtime/session-role.test.ts` (new, ~30 LOC)

```typescript
test("KNOWN_SESSION_ROLES matches adapter-wiring.md Rule 2", ...);
test("isSessionRole accepts canonical roles", ...);
test("isSessionRole accepts debate-* roles", ...);
test("isSessionRole rejects unknown roles", ...);
test("isSessionRole rejects empty debate- prefix", ...);
```

## Validation

1. **Unit + integration suites pass:** `bun run test`
2. **`tdd-calc` dogfood:** re-run `nax run` against `nax-dogfood/fixtures/tdd-calc/`. Verify:
   - `prompt-audit/tdd-calc/<runId>.jsonl` has exactly N entries for N agent dispatches (no duplicates)
   - Per-role files: `*-test-writer.txt`, `*-implementer.txt`, `*-verifier.txt`
   - No `run-run-US-001.txt` files
   - Acceptance file: `*-acceptance-gen-complete.txt` (not `*-acceptance-complete.txt`)
3. **`hello-lint` dogfood:** re-run; verify no `run-run-US-001*` files appear (the original #771 symptom)
4. **Cost report:** `nax cost --runId <id>` shows per-dispatch lines and an operation summary line; numbers match wire cost (no estimated/exact mismatch from #772)
5. **Grep gates:**
   - `rg 'executeHop' src/runtime/middleware/` returns zero hits
   - `rg 'sessionHint' src/` returns zero hits (tactical patch fully removed)
   - `rg 'sessionNameFromCompleteOptions' src/` returns zero hits

## Rollback

This wave is one PR. Reverting it restores the tactical patch's behaviour (TDD audit names work; #771/#772 guards still in place). No data migration; no on-disk format change beyond filename casing.

## Risk + mitigation

| Risk | Mitigation |
|:---|:---|
| Subscriber error swallowed and audit silently stops | `DispatchEventBus.emitDispatch` catches per-listener exceptions; logs via project logger; continues |
| Plugin authors writing custom middleware see chain shrink | Only audit/cost/logging are removed; `AgentMiddleware` interface preserved for cancellation/other uses; deprecation note in `agent-middleware.ts` |
| Per-call cost summing in `runWithFallback` introduces race with parallel hops | `runWithFallback` is sequential per call; no race. Document this as an invariant in the dispatch-events doc |
| Session role typed union breaks in-flight test fixtures with hardcoded roles | Step 3's typecheck pass surfaces every fixture; fix mechanically — the registry is the canonical list |
| `MiddlewareContext` shape change breaks third-party plugins | No third-party plugins exist today (in-repo only); change documented in CHANGELOG |

## Out of scope

- `wrapAdapterAsManager` removal → Wave 2
- `Operation.verify`/`recover` → Wave 3
- ADR-021 / orchestrator hierarchy — explicitly rejected per ADR-020 §A5
- Transformer middleware — Phase 1 observer-only invariant from ADR-018 §3.1 stands
