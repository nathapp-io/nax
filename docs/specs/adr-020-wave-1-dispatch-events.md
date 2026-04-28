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

**New file: `src/runtime/dispatch-events.ts`** (~140 LOC)

> **Verified imports** (use these exact paths — the originals were wrong):
> - `PipelineStage` lives at `../config/permissions` (NOT `../pipeline/types`)
> - `AgentResult.tokenUsage` is the field name (NOT `usage`)
> - `ResolvedPermissions` lives at `../config/permissions`
> - `internalRoundTrips` is **not** on the typed `AgentResult`. Either: (a) add it as `internalRoundTrips?: number` to `src/agents/types.ts:AgentResult` (recommended, ~3 LOC), or (b) keep it off the type and source `turn` from `SessionManager` descriptor turn count. **Decision for this wave: option (a)** — make it a typed field; existing audit middleware already reads it via type assertion (`as { internalRoundTrips: number }`), so the field is de facto present at runtime.

```typescript
import type { TokenUsage } from "../agents/types";
import type { PipelineStage, ResolvedPermissions } from "../config/permissions";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { SessionRole } from "./session-role";

/**
 * Fields every dispatch event carries, regardless of kind. New cross-cutting
 * fields (e.g. traceId, packageId) go here once; both variants and every
 * subscriber pick them up via the compiler.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D1
 */
export interface DispatchEventBase {
  readonly sessionName: string;
  readonly sessionRole: SessionRole;
  readonly prompt: string;
  readonly response: string;                       // result.output
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly featureName?: string;
  readonly workdir?: string;
  readonly projectDir?: string;
  readonly resolvedPermissions: ResolvedPermissions;  // resolved by pre-chain in manager
  readonly tokenUsage?: TokenUsage;
  readonly exactCostUsd?: number;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface SessionTurnDispatchEvent extends DispatchEventBase {
  readonly kind: "session-turn";
  readonly turn: number;
  readonly protocolIds: { sessionId?: string; turnId?: string };
  /** Diagnostic only — never branch subscriber logic on this. */
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
        getSafeLogger()?.warn("dispatch-bus", "listener threw", { error: errorMessage(err) });
      }
    }
  }
  emitOperationCompleted(event: OperationCompletedEvent) {
    for (const l of this._completedListeners) {
      try { l(event); }
      catch (err) {
        getSafeLogger()?.warn("dispatch-bus", "completion-listener threw", { error: errorMessage(err) });
      }
    }
  }
}
```

**Wire into `NaxRuntime`** (`src/runtime/index.ts`):

1. Add `readonly dispatchEvents: IDispatchEventBus` to the `NaxRuntime` interface (line ~47).
2. In `createRuntime` (line ~102), instantiate `const dispatchEvents = new DispatchEventBus()` early (before manager construction so it can be passed in).
3. Pass `dispatchEvents` into `createAgentManager(config, { dispatchEvents })` and `new SessionManager({ dispatchEvents, ... })` constructors.
4. Both managers store the bus on a private field (`this._dispatchEvents`) for emission inside `runAsSession` / `runTrackedSession` / `completeAs`.
5. Subscribers (`attachAuditSubscriber`, `attachCostSubscriber`, `attachLoggingSubscriber`) called from `createRuntime` after the bus exists; their unsubscribe functions stored for `runtime.close()` cleanup.

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

Capture `startedAt` at entry; emit after successful adapter return; remove the existing middleware `runBefore`/`runAfter` calls (they're replaced by event emission, see Step 7):

```typescript
async runAsSession(
  agentName: string,
  handle: SessionHandle,
  prompt: string,
  opts: AgentRunOptions,        // existing param
): Promise<TurnResult> {
  const startedAt = Date.now();
  const resolvedPermissions = resolvePermissions(opts.config, opts.pipelineStage);

  // ... (existing adapter dispatch — unchanged)
  const result = await adapter.sendTurn(handle, prompt, { ... });

  // Emit dispatch event before returning. Errors caught — must not block the call.
  const event: SessionTurnDispatchEvent = {
    kind: "session-turn",
    sessionName: handle.id,
    sessionRole: handle.role,           // post-D6: required SessionRole
    prompt,
    response: result.output,
    agentName,
    stage: opts.pipelineStage,
    storyId: opts.storyId,
    featureName: opts.featureName,
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    resolvedPermissions,
    turn: result.internalRoundTrips ?? 0,
    protocolIds: result.protocolIds ?? {},
    origin: "runAsSession",
    tokenUsage: result.tokenUsage,
    exactCostUsd: result.exactCostUsd,
    durationMs: Date.now() - startedAt,
    timestamp: Date.now(),
  };
  this._dispatchEvents.emitDispatch(event);

  return result;
}
```

**Error path:** `runAsSession` should emit an error variant for failed dispatches so audit can record `recordError`. Add a third event variant:

```typescript
// In dispatch-events.ts
export interface DispatchErrorEvent {
  readonly kind: "error";
  readonly origin: "runAsSession" | "runTrackedSession" | "completeAs";
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly prompt?: string;
  readonly durationMs: number;
  readonly timestamp: number;
  readonly resolvedPermissions: ResolvedPermissions;
}

// Add to bus:
emitDispatchError(event: DispatchErrorEvent): void;
onDispatchError(listener: (e: DispatchErrorEvent) => void): () => void;
```

In `runAsSession`'s try/catch around the adapter call, emit `DispatchErrorEvent` on throw, then re-throw. Audit subscriber listens to both `DispatchEvent` and `DispatchErrorEvent`.

### Step 5 — Emit from `runTrackedSession`

**File: `src/session/manager-run.ts`** lines 36–110.

Capture `startedAt` at entry; emit after `runner.run(injectedRequest)` returns successfully (around current line 82). Note: `runTrackedSession` returns `AgentResult`, not `TurnResult`, so the type assertion for `internalRoundTrips` documented in Step 2 applies.

```typescript
export async function runTrackedSession(
  state: SessionManagerState,
  id: string,
  runner: SessionRunClient,
  request: SessionManagedRunRequest,
): Promise<AgentResult> {
  const startedAt = Date.now();
  const pre = state.sessions.get(id);
  if (!pre) { /* existing throw */ }

  const descriptor = pre;  // alias for clarity
  // ... (existing transition + injectedRequest construction)

  const result = await runner.run(injectedRequest);

  // Build dispatch event from descriptor (which owns role + sessionName).
  // resolvedPermissions: forwarded from runOptions if pre-resolved by caller;
  // else re-resolve here (cheap; pure function).
  const sessionName = state.nameFor({
    workdir: descriptor.workdir,
    featureName: descriptor.featureName,
    storyId: descriptor.storyId,
    role: descriptor.role,
  });

  const event: SessionTurnDispatchEvent = {
    kind: "session-turn",
    sessionName,
    sessionRole: descriptor.role,                          // post-D6: required SessionRole
    prompt: request.runOptions.prompt,
    response: result.output,
    agentName: request.runOptions.agentName ?? state.defaultAgent,
    stage: request.runOptions.pipelineStage,
    storyId: descriptor.storyId,
    featureName: descriptor.featureName,
    workdir: descriptor.workdir,
    projectDir: request.runOptions.projectDir,
    resolvedPermissions: request.runOptions.resolvedPermissions
      ?? resolvePermissions(request.runOptions.config, request.runOptions.pipelineStage),
    turn: (result as { internalRoundTrips?: number }).internalRoundTrips ?? 0,
    protocolIds: result.protocolIds ?? {},
    origin: "runTrackedSession",
    tokenUsage: result.tokenUsage,
    exactCostUsd: result.exactCostUsd,
    durationMs: Date.now() - startedAt,
    timestamp: Date.now(),
  };
  state.dispatchEvents.emitDispatch(event);

  return result;
}
```

**Threading changes** (apply to `src/session/manager-run.ts` types and `src/session/manager.ts`):

- `SessionManagerState` interface (top of `manager-run.ts`) gains:
  - `dispatchEvents: IDispatchEventBus`
  - `defaultAgent: string` (so the `agentName` fallback isn't a hardcoded literal)
- `SessionManager` constructor accepts `{ dispatchEvents, defaultAgent }` and threads both into the state bag passed to `runTrackedSession`.
- `NaxRuntime.createRuntime` passes both at construction (defaultAgent comes from `resolveDefaultAgent(config)`).

**Delete the tactical `sessionHint` field-write** at the top of `runTrackedSession` (added by the tactical patch at `manager-run.ts:55-72`). Event emission replaces it.

**Error path:** if `runner.run()` throws, emit `DispatchErrorEvent` (kind:"error", origin:"runTrackedSession") in the catch block before re-throwing.

### Step 6 — Emit from `completeAs`

**File: `src/agents/manager.ts`** — find `completeAs(agentName, prompt, opts)` (grep for `completeAs` definition; line varies).

Capture `startedAt`; emit after successful adapter return. Move `formatSessionName` call from `audit.ts:sessionNameFromCompleteOptions` here — `completeAs` is the new owner of the computation.

```typescript
async completeAs(
  agentName: string,
  prompt: string,
  opts: AgentCompleteOptions,
): Promise<CompleteResult> {
  const startedAt = Date.now();
  const resolvedPermissions = resolvePermissions(opts.config, opts.pipelineStage);

  // ... (existing adapter.complete dispatch — unchanged)
  const result = await adapter.complete(prompt, opts);

  const sessionName = formatSessionName({
    workdir: opts.workdir,
    featureName: opts.featureName,
    storyId: opts.storyId,
    role: opts.sessionRole,
    pipelineStage: opts.pipelineStage,
  });

  const event: CompleteDispatchEvent = {
    kind: "complete",
    sessionName,
    sessionRole: opts.sessionRole ?? "main",        // post-D6: required SessionRole
    prompt,
    response: result.output,
    agentName,
    stage: opts.pipelineStage,
    storyId: opts.storyId,
    featureName: opts.featureName,
    workdir: opts.workdir,
    projectDir: opts.projectDir,
    resolvedPermissions,
    tokenUsage: result.tokenUsage,
    exactCostUsd: result.exactCostUsd,
    durationMs: Date.now() - startedAt,
    timestamp: Date.now(),
  };
  this._dispatchEvents.emitDispatch(event);

  return result;
}
```

**Error path:** same pattern — emit `DispatchErrorEvent` (kind:"error", origin:"completeAs") in catch before re-throwing.

### Step 7 — Strip middleware emission from envelopes; emit `OperationCompletedEvent`

**File: `src/agents/manager.ts`**.

In `runAs()` (line 395–440): remove `_middleware.runBefore` + `_middleware.runAfter` calls. They were the duplicate-emission source. Permission resolution (pre-chain) stays — still required.

In `runWithFallback()` (line 181–306): track per-hop telemetry directly from the loop, no event subscription needed.

```typescript
async runWithFallback(
  request: AgentRunRequest,
  primaryAgentOverride?: string,
): Promise<AgentRunOutcome> {
  const startedAt = Date.now();
  const agentChain: string[] = [];
  const hopCosts: number[] = [];
  let finalStatus: OperationCompletedEvent["finalStatus"] = "ok";
  let outcome: AgentRunOutcome | undefined;

  try {
    // ... existing fallback loop ...
    // Inside the loop, after each executeHop / runAsSession completes:
    agentChain.push(currentAgent);
    if (hopResult.exactCostUsd !== undefined) hopCosts.push(hopResult.exactCostUsd);
    // ... existing swap logic ...

    if (request.signal?.aborted) finalStatus = "cancelled";
    else if (!outcome) finalStatus = "exhausted";
  } catch (err) {
    finalStatus = "error";
    throw err;
  } finally {
    this._dispatchEvents.emitOperationCompleted({
      kind: "operation-completed",
      operation: "run-with-fallback",
      agentChain,
      hopCount: agentChain.length,
      fallbackTriggered: agentChain.length > 1,
      totalElapsedMs: Date.now() - startedAt,
      totalCostUsd: hopCosts.reduce((a, b) => a + b, 0),
      finalStatus,
      storyId: request.runOptions?.storyId,
      stage: request.runOptions?.pipelineStage ?? "run",
      timestamp: Date.now(),
    });
  }
  return outcome;
}
```

Same treatment for `completeWithFallback` (single hop in the no-fallback case → `agentChain = [agent]`, `hopCount = 1`, `fallbackTriggered = false`).

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

All event fields above are already declared on `DispatchEventBase` in Step 2 (response, workdir, projectDir, resolvedPermissions included from the start) and populated by each emitter in Steps 4–6.

Wire `attachAuditSubscriber` into runtime construction (`src/runtime/index.ts` `createRuntime`) after the bus is instantiated; replace the existing `auditMiddleware(...)` registration. Store the unsubscribe handle for `runtime.close()` cleanup.

Add `attachAuditSubscriber` for `DispatchErrorEvent` too:

```typescript
bus.onDispatchError((event) => {
  auditor.recordError({
    ts: event.timestamp,
    runId,
    agentName: event.agentName,
    stage: event.stage,
    storyId: event.storyId,
    errorCode: event.errorCode,
    errorMessage: event.errorMessage,
    durationMs: event.durationMs,
    callType: event.origin === "completeAs" ? "complete" : "run",
    permissionProfile: event.resolvedPermissions.mode,
    prompt: event.prompt,
  });
});
```

**Delete:** `src/runtime/middleware/audit.ts` lines 30 (`executeHop` guard), 12–24 (`sessionNameFromCompleteOptions` helper), and the entire `auditMiddleware(auditor, runId): AgentMiddleware` factory function. Replace the file's exports with `attachAuditSubscriber`.

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

The tactical patch (Step 5 of the findings doc) introduced `AgentRunOptions.sessionHint` and a populator in `runTrackedSession`. Both are made redundant by Wave 1's `DispatchEvent` emission. Removal is mechanical:

| File | Change |
|:---|:---|
| `src/agents/types.ts` | Delete `AgentRunOptions.sessionHint` field declaration (the typed `{ sessionName: string; role: string }` field added by the tactical) |
| `src/session/manager-run.ts` | Delete the `sessionHint: { sessionName, role }` write inside `injectedRequest.runOptions` (Step 5 of tactical). Step 5 of this wave replaces it with `emitDispatch`. |
| `src/runtime/middleware/audit.ts` | The `?? ctx.request?.runOptions?.sessionHint?.sessionName ??` line — already removed by Step 8's full rewrite. Listed here for completeness. |
| `src/runtime/middleware/cost.ts` | Same. Already removed by Step 9's full rewrite. |

**Validation:** `rg sessionHint src/` returns zero hits. `rg sessionHint test/` returns zero hits except in tests that explicitly assert the field has been removed (the no-regression test from Step 11 below).

### Step 12 — `MiddlewareContext` and chain cleanup

**File: `src/runtime/agent-middleware.ts`**.

Audit/cost/logging are no longer middleware — they're event subscribers. **Inventory remaining middleware:**

```bash
rg "implements AgentMiddleware\|: AgentMiddleware\|AgentMiddleware = {" src/
```

Expected after Wave 1: only `cancellation.ts` remains (it translates aborted signals into typed errors and is stage-agnostic — does not read dispatch metadata).

**Decision:** keep the `AgentMiddleware` interface and `MiddlewareChain` plumbing for cancellation. Do **not** delete the chain entirely — that would force cancellation into a fourth event type unnecessarily.

**Trim `MiddlewareContext`:** remove fields that exist only for audit/cost scraping. Specifically delete:
- `completeOptions` (was only read by `sessionNameFromCompleteOptions`)
- `sessionHandle` (was only read by audit's session-name resolution)
- `prompt` (was only read for audit recording)
- Any `executeHop`-related fields on the request

Keep:
- `signal` (cancellation reads it)
- `agentName`, `stage`, `storyId` (cancellation logs them on translated errors)
- `kind` (`"run"` | `"complete"` — cancellation needs to surface the right error code)
- `resolvedPermissions` (cancellation translates permission-denied separately)

**Output:** `MiddlewareContext` shrinks from ~12 fields to ~6. Cancellation middleware keeps working unchanged. Audit/cost no longer touch the chain.

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
