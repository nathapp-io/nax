# SPEC: Surface callOp cost via CostAggregator scopes (replace `onCostAccumulated` side channel)

**Issues:** #1035, #1036
**Related ADRs:** ADR-019 (Operation layer), ADR-020 (DispatchBoundary SSOT)
**Status:** Draft

---

## Summary

Replace the `CallContext.onCostAccumulated` callback — a side-channel surfaced into the operation layer by the quick fixes for #1035 and #1036 — with a query API on `CostAggregator`. Cost recording is universal infrastructure: every dispatch is always captured by the cost middleware and always lands in the aggregator. Code that wants to *attribute* cost to a logical region (one debate run, one resolver call, one TDD session) opens a **cost scope** tagged with a `scopeId`; the scope reads from the bus-driven aggregator. Selectors, debaters, and other leaf-level code stay completely cost-blind — they forward whatever `CallContext` they were handed. `callOp` keeps its `Promise<O>` contract; agent adapters remain primitive; `DispatchEvent` → cost middleware → `CostAggregator` is the single, authoritative cost flow.

## Motivation

### What the quick fix did

PR #1034 added an optional `onCostAccumulated?: (costUsd: number) => void` on `CallContext` and wired it inside `callOp` at two sites:

```typescript
// src/operations/call.ts:153 — complete-kind success path
const raw = await ctx.runtime.agentManager.completeAs(dispatchAgent, prompt, completeOptions);
ctx.onCostAccumulated?.(raw.estimatedCostUsd);

// src/operations/call.ts:422 — run-kind success path
const totalCost = outcome.result.estimatedCostUsd ?? 0;
ctx.onCostAccumulated?.(totalCost);
```

Debate code consumes it with a mutable closure pattern, e.g. `src/debate/selectors/judge.ts`:

```typescript
let resolverCostUsd = 0;
const callCtx = { ...ctx.callContext, onCostAccumulated: (c) => { resolverCostUsd += c; } };
const output = await callOp(callCtx, judgeOp, { ... });
return { outcome: ..., output, resolverCostUsd };
```

Used today in: `src/debate/selectors/judge.ts`, `src/debate/selectors/synthesis.ts`, `src/debate/runner-stateful.ts`, `src/debate/runner-hybrid.ts`.

### Why this needs to change

1. **Two sources of truth.** Cost already exits the adapter as `estimatedCostUsd` / `exactCostUsd` on `DispatchEvent` (`src/runtime/dispatch-events.ts:27-28`), flows through `attachCostSubscriber` (`src/runtime/middleware/cost.ts`) into `CostAggregator` (`src/runtime/cost-aggregator.ts`). The callback walks a parallel path and only sees `estimatedCostUsd` — it cannot represent the `exact` confidence the aggregator carries. Run-kind retry attempts add another asymmetry: the strategy may sum per-turn costs internally and only the merged result hits the callback, so even the totals are not aligned with what the aggregator records per-turn.
2. **Leaks output concerns into `CallContext`.** `CallContext` is the dispatch-context: who calls, in what session, with what permissions. A "send me back cost" hook is an output-shape concern. ADR-019 deliberately kept `callOp`'s return type a pure `Promise<O>`; the callback re-introduces an out-of-band return value.
3. **Forces every caller to own a mutable accumulator.** `let totalCostUsd = 0; … += c` patterns now sit in selectors and runners. They are easy to copy wrong (forget to thread the callback through a wrapped `CallContext`, or double-count when both a selector and its runner subscribe).
4. **Adapter-primitive principle.** The wire-level adapter already does the right thing: it emits cost on each turn. Anything beyond "emit on the bus" should not grow new entry points into `callOp` or the adapter — subscribers are the extension point.

### Constraints the redesign must honour

- Agent adapter contract (`adapter.openSession`/`sendTurn`/`closeSession`/`complete`) **does not change.** No new field, no new callback.
- `callOp`'s signature stays `Promise<O>` — no envelope wrapper, no overload. Cost is queried externally.
- `CostAggregator` already exists and already snapshots per-agent / per-stage / per-story. We extend its grouping, not its identity.
- Cost middleware (`attachCostSubscriber`) stays as the only writer.

## Design

### Approach

Two correlation dimensions on `DispatchEventBase`, with different owners:

- **`callId`** — per-`callOp` invocation. Stamped automatically by `callOp` at entry, never set by anyone else. Used for debug attribution ("which one op invocation produced this event?"). Carried across retry attempts within one invocation.
- **`scopeId`** — per-region. Set by the caller via `CallContext.scopeId`; `callOp` forwards verbatim onto every emitted dispatch event. The aggregator filters by `scopeId` to answer "what did this region cost?"

The scope is the **only** opt-in. Cost recording itself is always-on — middleware writes every dispatch into the aggregator unconditionally. Code that wants to know what a region cost opens a scope; code that doesn't care never touches cost APIs.

Crucially, **leaf code (selectors, debater closures) stays cost-blind.** The selector receives a `CallContext` and forwards it to `callOp`. The runner one layer up is what knows "this is one debate" or "this is the resolver call" and is the layer that opens scopes and reads snapshots. `SelectorResult.resolverCostUsd` is deleted entirely — selectors return only `{ outcome, output }`.

```
                                ┌─────────────┐
                  caller sets   │ CallContext │  callOp auto-stamps callId
                ┌───scopeId────▶│  .scopeId   │  (never overwrites scopeId)
                │               │  .callId?   │
                │               └──────┬──────┘
                │                      │
        ┌───────┴────────┐             ▼
        │ DebateRunner   │      ┌──────────────┐    ┌────────────┐
        │ owns the scope │      │   callOp     │───▶│ DispatchBus│
        └───────┬────────┘      └──────────────┘    └─────┬──────┘
                │                                         │ event {callId, scopeId}
                │                            attachCostSub│scriber
                │                                         ▼
                │                                ┌────────────────┐
                │            snapshot            │ CostAggregator │
                └───────────────────────────────▶│  .byScope(id)  │
                                                 └────────────────┘
```

Selectors never appear in this diagram — they're just `await callOp(ctx.callContext, op, input)` and are unaware cost exists.

### New types

```typescript
// src/runtime/dispatch-events.ts
export interface DispatchEventBase {
  // ... existing fields ...
  /**
   * Per-callOp invocation id, stamped by the operation layer. Optional only
   * because legacy non-op dispatch sites may not stamp it; in production every
   * callOp-driven event carries one.
   */
  readonly callId?: string;
  /**
   * Caller-supplied region id, forwarded verbatim from `CallContext.scopeId`.
   * Used by `CostAggregator.byScope()` and `CostScopeHandle.snapshot()` to roll
   * up cost across many `callOp` invocations sharing one region.
   */
  readonly scopeId?: string;
}
// Same two fields added to DispatchErrorEvent and OperationCompletedEvent.
```

```typescript
// src/operations/types.ts
export interface CallContext {
  // ... existing fields ...
  /**
   * Optional region id forwarded onto every dispatch event the op produces.
   * Set by orchestration layers (e.g. debate runners) that own the region;
   * leaf code (selectors, debater closures) never sets or reads this.
   */
  readonly scopeId?: string;
  /**
   * Optional pinned callId. Almost never set by callers — `callOp` generates
   * a fresh one when absent. Reserved for advanced patterns where two callers
   * must share an invocation id (none in this spec).
   */
  readonly callId?: string;
}
```

```typescript
// src/runtime/cost-aggregator.ts
export interface CostScopeHandle {
  /** The scopeId this handle filters by. Pass it into CallContext.scopeId. */
  readonly scopeId: string;
  /** Totals across events recorded with this scope's scopeId at call time. */
  snapshot(): CostSnapshot;
  /** Idempotent release of internal indexes. */
  close(): void;
}

export interface ICostAggregator {
  // ... existing methods ...
  /** Per-invocation totals (groups by `callId`; debug-only). */
  byCall(): Record<string, CostSnapshot>;
  /** Per-region totals (groups by `scopeId`). */
  byScope(): Record<string, CostSnapshot>;
  /**
   * Opens a region scope. When `scopeId` is omitted the aggregator generates
   * one via the shared id helper and exposes it on `handle.scopeId`.
   */
  openScope(scopeId?: string): CostScopeHandle;
}
```

```typescript
// src/operations/call.ts — internal helper, sole producer of correlation ids
function newCorrelationId(): string {
  // ≤16 chars: `${ts.toString(36)}-${random6}`
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
```

`newCorrelationId` lives in `src/operations/call.ts` and serves both `callId` generation inside `callOp` and `scopeId` generation inside `openScope()` (via a small internal import). Callers never invoke it directly.

### Flow

1. `callOp` stamps a fresh `callId` per invocation (never overwrites `ctx.callId` if the caller pinned one).
2. `callOp` forwards both `callId` and `ctx.scopeId` (verbatim) into:
   - `completeOptions` for complete-kind, threaded through `agentManager.completeAs`.
   - `runOptions` for run-kind, threaded through `runWithFallback` and the session-run-hop layer.
3. The session/manager layers carry both fields into `DispatchEvent`, `DispatchErrorEvent`, and `OperationCompletedEvent` they emit on the bus.
4. `attachCostSubscriber` writes both `callId` and `scopeId` onto every `CostEvent` it forwards to `CostAggregator`.
5. `CostAggregator.openScope(scopeId).snapshot()` returns canonical totals (using `costUsd`, which after US-001 is always equal to `exactCostUsd`).

### Caller pattern

**Selector (cost-blind — no scope, no `resolverCostUsd` return):**

```typescript
// src/debate/selectors/judge.ts
export const judgeSelector: Selector = async (ctx) => {
  const output = await callOp(ctx.callContext, judgeOp, { ... });
  return {
    outcome: output.trim() ? "passed" : "failed",
    output,
  };
};
```

**Runner (owns scopes, populates `DebateResult.totalCostUsd`):**

```typescript
// src/debate/runner-stateful.ts (sketch)
const debaterScope = ctx.runtime.costAggregator.openScope();
const resolverScope = ctx.runtime.costAggregator.openScope();
try {
  const debaterCallContext = (agent, i): CallContext => ({
    ...baseDebaterCallContext(ctx, agent),
    sessionOverride: { role: debaterRole(i) },
    scopeId: debaterScope.scopeId,  // ← runner stamps; debater closure never sees this
  });
  await Promise.allSettled(
    resolved.map(({ debater, agentName }, i) =>
      callOp(debaterCallContext(agentName, i), statefulDebaterOp, { ... }),
    ),
  );

  const selectorCtx: SelectorContext = {
    ...buildSelectorContext(ctx),
    callContext: { ...ctx.callContext, scopeId: resolverScope.scopeId },
  };
  const selectorResult = await selector(selectorCtx);

  return {
    ...buildDebateResult(ctx, proposals, rebuttals, selectorResult),
    totalCostUsd: debaterScope.snapshot().totalCostUsd + resolverScope.snapshot().totalCostUsd,
  };
} finally {
  debaterScope.close();
  resolverScope.close();
}
```

### Removed surface

- `CallContext.onCostAccumulated` — deleted from `src/operations/types.ts`.
- Both write sites in `src/operations/call.ts` (complete-kind success path; run-kind success path) — deleted.
- `SelectorResult.resolverCostUsd` field — deleted from `src/debate/selectors/types.ts`. Every selector return loses the field; readers in `runner-stateful.ts`, `runner-hybrid.ts`, `runner.ts`, `runner-plan-helpers.ts`, `session-helpers.ts`, `selectors/dialogue-verdict.ts`, `selectors/verifier-pick.ts`, `selectors/majority.ts` stop reading it (they read scope snapshots instead).
- Mutable `let resolverCostUsd = 0` / `let totalCostUsd = 0` accumulators in `judge.ts`, `synthesis.ts`, `runner-stateful.ts`, `runner-hybrid.ts`.

### Failure handling

- **Scope opened but no dispatch event fires before close** → `snapshot()` returns `EMPTY_SNAPSHOT`. Correct: no work was done in the region.
- **Scope never closed** → events accumulate against the scopeId in the aggregator's internal index until the run ends. No correctness impact; small memory leak. `CostAggregator.drain()` logs `warn` with `{ openScopeCount }` if any scopes remain open at drain time.
- **`scopeId` collision** (vanishingly unlikely; timestamp + 6-char random) → totals merge. Same risk profile as `callId`.
- **Legacy callers still passing `onCostAccumulated` or reading `SelectorResult.resolverCostUsd`** → compile error after the field is removed. Hard cut, not soft deprecation; every consumer is in `src/debate/` and migrates in the same PR set.
- **No aggregator wired** (`createNoOpCostAggregator`) → `openScope()` returns a no-op handle whose `snapshot()` always reports zero. Production runtime always wires a real `CostAggregator`, so cost recording is universally on; the no-op path exists only for tests and ad-hoc CLI invocations that explicitly opt out of the run-level cost subsystem.

### Approach choices considered and rejected

| Alternative | Why rejected |
|:---|:---|
| Single `callId` dimension; selectors open per-call scopes | Forces leaf code (selectors, debater closures) to know cost exists. Violates the "selectors are cost-blind" principle and reintroduces the threading pattern the side-channel callback was trying to avoid. |
| Selectors keep `SelectorResult.resolverCostUsd`, populated from a scope they open | Same problem: selectors are still cost-aware. Region attribution belongs one layer up, with the code that defines what the region *is*. |
| Wrap `callOp` return in `{ output, costUsd }` envelope | Every caller pays the type-shape cost, even ones that don't care. `Promise<O>` is the contract ADR-019 fought for. |
| Read cost from `aggregator.byStage()` / `byStory()` and subtract before/after | Race-prone under concurrent dispatch (debate fans out per agent in parallel). `scopeId` is the deterministic primitive. |
| Emit a new event kind (`CostObservedEvent`) | Duplicates `DispatchEvent` which already carries cost. New event ≠ new information. |
| Have `callOp` consult the aggregator internally and return `{ output, callId }` | Hides the read inside the op layer and pushes attribution back to the caller anyway. |
| Add `runtime.withCostScope(fn)` higher-order wrapper | Higher-order form is harder to compose with `Promise.allSettled` fan-out patterns the debate runners need. Explicit `openScope` + `try/finally` keeps the lifetime visible. |

## Stories

1. **US-001: Normalize `exactCostUsd` — make required, fall back to `estimatedCostUsd`** — depends on nothing
2. **US-002: Add `callId` + `scopeId` to dispatch event base; stamp / forward at callOp** — depends on nothing (parallelizable with US-001)
3. **US-003: Aggregator scope API (`openScope`, `byScope`, `byCall`)** — depends on US-001 + US-002
4. **US-004: Strip cost from selectors — delete `SelectorResult.resolverCostUsd`, delete `onCostAccumulated`** — depends on US-003
5. **US-005: `runner-stateful` + `runner-hybrid` — two-scope conversion** — depends on US-003 + US-004
6. **US-006: `runner.ts` — four-scope conversion (pre-debate, debaters, selector, verifier)** — depends on US-003 + US-004 (parallelizable with US-005)
7. **US-007: Update `retry-strategy.md` + `adapter-wiring.md` to document the always-on cost flow** — depends on US-005 + US-006

---

### US-001: Normalize `exactCostUsd` — make required, fall back to `estimatedCostUsd`

#### Scope

Today `exactCostUsd` is optional on `DispatchEventBase`, `CostEvent`, and `CostSnapshot.totalExactCostUsd`. `attachCostSubscriber` does `exactCostUsd ?? estimatedCostUsd ?? 0` to derive `costUsd` and uses `exactCostUsd != null` to derive `confidence`. This forces every reader to repeat the same `??` ladder and makes "was this the wire value?" two pieces of state instead of one.

Make `exactCostUsd` required on the event types and on `CostSnapshot.totalExactCostUsd`. When the wire does not report an exact cost, the producer (cost middleware) sets `exactCostUsd = estimatedCostUsd` and sets `confidence = "estimated"`. The `confidence` field becomes the sole discriminator; `costUsd === exactCostUsd` always.

#### Approach

The change is at the producer boundary (`attachCostSubscriber`), not at the wire boundary (adapter primitives unchanged). Adapters continue to emit `exactCostUsd: number | undefined`; the middleware normalizes immediately before writing to the aggregator and before the value crosses the bus into any other subscriber.

#### Context Files

- `src/runtime/dispatch-events.ts` — `DispatchEventBase.exactCostUsd` (currently optional). Wire boundary stays optional (see note below).
- `src/runtime/cost-aggregator.ts` — `CostEvent.exactCostUsd`, `CostSnapshot.totalExactCostUsd`, `accumulate()`
- `src/runtime/middleware/cost.ts` — normalization site
- `src/cli/status-cost.ts` — any reader that branches on `exactCostUsd === undefined`
- `test/unit/runtime/cost-aggregator.test.ts`, `test/unit/runtime/middleware/cost.test.ts` — confidence + total assertions

#### Acceptance Criteria

- `CostEvent.exactCostUsd` and `CostSnapshot.totalExactCostUsd` are declared as required `number` (no `?:`)
- `attachCostSubscriber` constructs every `CostEvent` with `exactCostUsd = event.exactCostUsd ?? estimatedCostUsd` so the field is never `undefined` after the middleware boundary
- `attachCostSubscriber` sets `confidence = "exact"` when the source `event.exactCostUsd` is a finite number, else `"estimated"` — derived from input presence, not from output equality
- `CostEvent.costUsd === CostEvent.exactCostUsd` for every event the middleware emits (invariant; the previous `exactCostUsd ?? estimatedCostUsd` ladder no longer applies at read sites)
- `CostAggregator.accumulate()` increments `totalExactCostUsd` by `e.exactCostUsd` unconditionally (no `e.exactCostUsd != null` branch)
- `EMPTY_SNAPSHOT.totalExactCostUsd === 0`, and `CostAggregator.snapshot()` over zero events returns it (never `undefined`)
- `DispatchEventBase.exactCostUsd` remains optional at the **wire/adapter side** of the bus — adapters that cannot report exact cost continue to omit the field; normalization runs in `attachCostSubscriber` only, so adapter primitives are unchanged
- Drained JSONL `CostEvent` lines always include `exactCostUsd` as a number; no line emits `"exactCostUsd": null` or omits the field

---

### US-002: Add `callId` + `scopeId` to dispatch event base; stamp / forward at callOp

#### Scope

Add two optional fields — `callId` (per-invocation) and `scopeId` (per-region) — to `DispatchEventBase`, `DispatchErrorEvent`, and `OperationCompletedEvent`. `callOp` stamps a fresh `callId` per invocation and forwards `ctx.scopeId` verbatim onto every emitted dispatch event. Both fields are threaded through `agentManager.completeAs` (complete-kind) and `runOptions` (run-kind). `CallContext` gains the matching `scopeId?` and `callId?` fields.

#### Context Files

- `src/runtime/dispatch-events.ts` — event interface SSOT (extend `DispatchEventBase`)
- `src/operations/types.ts` — `CallContext` gains `scopeId?` and `callId?`
- `src/operations/call.ts` — stamp callId; forward both fields into `completeOptions` (complete-kind) and `runOptions` (run-kind)
- `src/agents/manager.ts` — `completeAs` / `runWithFallback` must accept and forward both fields into emitted events
- `src/runtime/session-run-hop.ts` — `runAsSession` event emission site
- `docs/adr/ADR-020-dispatch-boundary-ssot.md` §D1 — "new cross-cutting fields go on `DispatchEventBase`" precedent

#### Acceptance Criteria

- `DispatchEventBase`, `DispatchErrorEvent`, and `OperationCompletedEvent` each declare `readonly callId?: string` and `readonly scopeId?: string`
- `CallContext` declares `readonly scopeId?: string` and `readonly callId?: string`
- `callOp(ctx, op, input)` stamps a fresh `callId` via `newCorrelationId()` when `ctx.callId` is absent, and never overwrites a caller-supplied `callId`
- `callOp` forwards `ctx.scopeId` verbatim onto every emitted dispatch event (no transformation, no generation if absent)
- For `kind:"complete"` ops, the `CompleteDispatchEvent` emitted by `agentManager.completeAs` carries the invocation's `callId` and `ctx.scopeId`
- For `kind:"run"` ops, every `SessionTurnDispatchEvent`, the `OperationCompletedEvent` from `runWithFallback`, and any `DispatchErrorEvent` from a failed dispatch carry the same `callId` and `scopeId` as the invocation
- When `callOp` retries via `op.retry`, every dispatch event across retry attempts within one invocation shares the same `callId` and `scopeId`
- `newCorrelationId()` produces ≤16-char strings matching `/^[0-9a-z]+-[0-9a-z]+$/`; 10,000 sequential calls yield 10,000 distinct values

---

### US-003: Aggregator scope API (`openScope`, `byScope`, `byCall`)

#### Scope

Extend `CostAggregator` with `byScope()`, `byCall()`, and `openScope(scopeId?: string): CostScopeHandle`. Update `attachCostSubscriber` to copy both `event.scopeId` and `event.callId` onto the `CostEvent` it records. Scope handles filter by `scopeId` (the caller-supplied region dimension). `byCall` is exposed for debug/per-invocation attribution and is not consumed by production code.

#### Context Files

- `src/runtime/cost-aggregator.ts` — extend `ICostAggregator`, `CostAggregator`, add `CostScopeHandle`; reuse `newCorrelationId()` from `src/operations/call.ts`
- `src/runtime/middleware/cost.ts` — forward both `event.scopeId` and `event.callId` onto the constructed `CostEvent`
- `src/runtime/index.ts` — verify aggregator and new types exported from the barrel
- `test/unit/runtime/cost-aggregator.test.ts` — existing tests; mirror structure for `byScope` / `openScope`

#### Acceptance Criteria

- `CostEvent` declares `readonly scopeId?: string` and `readonly callId?: string`; `attachCostSubscriber` copies both from `DispatchEvent` (leaving undefined when source has none)
- `CostAggregator.byScope()` returns a `Record<string, CostSnapshot>` keyed by `scopeId`, including only events where `scopeId !== undefined`
- `CostAggregator.byCall()` returns a `Record<string, CostSnapshot>` keyed by `callId`, including only events where `callId !== undefined`
- `CostAggregator.openScope(scopeId)` returns a `CostScopeHandle` whose `scopeId` field equals the input; `openScope()` (no arg) generates one via `newCorrelationId()` and exposes it on `handle.scopeId`
- `CostScopeHandle.snapshot()` returns a `CostSnapshot` reflecting only `CostEvent`s recorded with `e.scopeId === handle.scopeId` at call time, aggregating `costUsd` into `CostSnapshot.totalCostUsd`
- `CostScopeHandle.snapshot()` returns `EMPTY_SNAPSHOT` when no events with the scope's `scopeId` have been recorded
- `CostScopeHandle.close()` is idempotent (second call is a no-op); after `close()`, `snapshot()` returns the totals frozen at the first `close()`
- `CostAggregator.drain()` logs at level `warn` with `{ openScopeCount: number }` when any scope is still open at drain time, and completes successfully

---

### US-004: Strip cost from selectors — delete `SelectorResult.resolverCostUsd`, delete `onCostAccumulated`

#### Scope

Make selectors completely cost-blind. Delete `CallContext.onCostAccumulated` and both write sites in `callOp`. Delete `SelectorResult.resolverCostUsd`. Strip every `let resolverCostUsd = 0` accumulator and `onCostAccumulated` closure from `judgeSelector` and `synthesisSelector`. Every reader of `SelectorResult.resolverCostUsd` is updated in this story so the codebase compiles after the field is removed (runners get their real cost-attribution rewrite in US-005 / US-006).

**Migration ordering — this story is one commit.** `SelectorResult.resolverCostUsd` is a required field today (`src/debate/selectors/types.ts:34`, no `?`); a partial removal does not type-check. All selector files and all readers must be migrated together.

Readers that today touch `resolverCostUsd`: `src/debate/selectors/dialogue-verdict.ts`, `src/debate/selectors/verifier-pick.ts`, `src/debate/selectors/majority.ts` (all return `resolverCostUsd: 0` today — drop the field from their return literals); `src/debate/runner.ts`, `src/debate/runner-plan-helpers.ts`, `src/debate/session-helpers.ts` (drop the field from the outcome shape; runner-side cost summation moves to US-005 / US-006).

#### Context Files

- `src/operations/types.ts` — remove `onCostAccumulated` field
- `src/operations/call.ts` — remove both `ctx.onCostAccumulated?.(...)` calls in the complete-kind and run-kind success paths
- `src/debate/selectors/types.ts` — remove `resolverCostUsd` from `SelectorResult`
- `src/debate/selectors/judge.ts`, `src/debate/selectors/synthesis.ts` — strip cost closure and `resolverCostUsd` from return
- `src/debate/selectors/dialogue-verdict.ts`, `src/debate/selectors/verifier-pick.ts`, `src/debate/selectors/majority.ts` — drop `resolverCostUsd` from return literals
- `src/debate/runner.ts`, `src/debate/runner-plan-helpers.ts`, `src/debate/session-helpers.ts` — drop `resolverCostUsd` from intermediate carry shapes (runner cost lands in US-005)
- `test/unit/debate/selectors/judge.test.ts`, `test/unit/debate/selectors/synthesis.test.ts` — assertions on `resolverCostUsd` move to scope-based assertions in US-005

#### Acceptance Criteria

- `CallContext` does not declare `onCostAccumulated`; `src/operations/call.ts` contains no reference to it
- `SelectorResult` does not declare `resolverCostUsd`
- `judgeSelector` and `synthesisSelector` return values whose only populated keys are within `Pick<SelectorResult, "outcome" | "output">` — no cost field, no scope opening, no mutable cost accumulator
- `judgeSelector` and `synthesisSelector` forward `ctx.callContext` unchanged into `callOp` (no `callId` injection, no `scopeId` injection — the runner already set `scopeId` upstream)
- `dialogueVerdictSelector`, `verifierPickSelector`, and `majoritySelector` returns also drop the `resolverCostUsd` key
- **Codebase invariant:** `grep -r "resolverCostUsd" src/` returns zero matches
- **Codebase invariant:** `grep -r "onCostAccumulated" src/` returns zero matches

---

### US-005: `runner-stateful` + `runner-hybrid` — two-scope conversion

#### Scope

Both runners have a clean two-stream cost shape today: one debater fan-out (`Promise.allSettled` over `callOp(statefulDebaterOp, …)`) and one resolver/selector call. Convert each runner to open two scopes — one for the fan-out, one for the resolver — stamp the matching `scopeId` into every `CallContext` they hand down, and populate `DebateResult.totalCostUsd` from the scope snapshots. No selector return value contributes to cost any more.

#### Context Files

- `src/debate/runner-stateful.ts` — `debaterCallContext` factory; `totalCostUsd` accumulator (replaced with scope read)
- `src/debate/runner-hybrid.ts` — same pattern; also wraps the resolver call
- `src/debate/session-helpers.ts` — `DebateResult.totalCostUsd` field unchanged; intermediate carry shapes (post-US-004) updated to drop `resolverCostUsd`
- `test/unit/debate/runner-hybrid-rebuttal.test.ts`, `test/unit/debate/runner-stateful.test.ts` — assertions on `DebateResult.totalCostUsd` re-pointed at scope-populated value

#### Acceptance Criteria

- `runStateful` opens one `debaterScope` and one `resolverScope` via `ctx.runtime.costAggregator.openScope()`; both are closed in a `finally` block regardless of resolution outcome
- Every `CallContext` produced by `debaterCallContext(agentName, index)` carries `scopeId: debaterScope.scopeId`; the `SelectorContext.callContext` passed into the resolver carries `scopeId: resolverScope.scopeId`
- `runStateful` returns `DebateResult.totalCostUsd === debaterScope.snapshot().totalCostUsd + resolverScope.snapshot().totalCostUsd`
- `runHybrid` follows the same two-scope pattern with the same `totalCostUsd` formula
- When two debaters each produce one dispatch event with `estimatedCostUsd = 0.05` and the resolver produces one event with `estimatedCostUsd = 0.02`, `DebateResult.totalCostUsd === 0.12`
- Per-debater closures contain no `let totalCostUsd = 0` accumulator and no callback threading — cost flows only through `scopeId` → bus → aggregator
- **Codebase invariant:** after this story, `grep -nE "totalCostUsd\\s*\\+=|let\\s+totalCostUsd" src/debate/runner-stateful.ts src/debate/runner-hybrid.ts` returns zero matches

---

### US-006: `runner.ts` — four-scope conversion (pre-debate, debaters, selector, verifier)

#### Scope

`src/debate/runner.ts` orchestrates four cost-producing phases: pre-debate phase (`resolvePreDebatePhase`), debater fan-out, selector/resolver, and the optional post-debate verifier. Today each phase carries its own `*.costUsd` return field that the runner sums into `let totalCostUsd = 0`. Convert all four to scopes:

| Phase | Scope variable | Source today |
|:--|:--|:--|
| Pre-debate | `prePhaseScope` | `prePhaseResult.costUsd` (`runner.ts:155`) |
| Debater fan-out | `debaterScope` | `let totalCostUsd = 0` accumulator + per-call `costUsd` adds |
| Selector/resolver | `resolverScope` | `selectorOutcome.resolverCostUsd` (`runner.ts:303`, removed in US-004) |
| Post-debate verifier | `verifierScope` | `verifierResult.costUsd` (`runner.ts:318`) |

The runner stops reading `prePhaseResult.costUsd` and `verifierResult.costUsd`; cost comes from `prePhaseScope.snapshot()` and `verifierScope.snapshot()`. **`resolvePreDebatePhase` and the post-debate verifier modules are not modified in this spec** — their return-shape `costUsd` fields become unread by `runner.ts` but remain in place. A follow-up issue will remove the now-unused fields once no consumer depends on them.

#### Context Files

- `src/debate/runner.ts` — `let totalCostUsd = 0` (line 115) + 3 add sites (lines 155, 303, 318) replaced with 4 scopes
- `src/debate/runner-plan-helpers.ts` — drop `resolverCostUsd: 0` literals (the field is gone after US-004)
- `test/unit/debate/runner.test.ts` (or equivalent) — assertions on `DebateResult.totalCostUsd` re-pointed at scope-populated value
- Pre-debate phase modules and verifier modules — **read only**, not modified; their `costUsd` returns become dead-on-read

#### Acceptance Criteria

- `runner.ts` opens four scopes (`prePhaseScope`, `debaterScope`, `resolverScope`, `verifierScope`) via `ctx.runtime.costAggregator.openScope()`; all four are closed in a single `finally` block (or `try/finally` chain) regardless of resolution outcome
- The `PreDebatePhaseContext` passed into `resolvePreDebatePhase(...)` carries `scopeId: prePhaseScope.scopeId` (threaded via the same `CallContext` mechanism the phase uses to dispatch)
- Every `CallContext` constructed for the debater fan-out carries `scopeId: debaterScope.scopeId`; the `SelectorContext.callContext` carries `scopeId: resolverScope.scopeId`; the verifier dispatch context carries `scopeId: verifierScope.scopeId`
- `runner.ts` returns `DebateResult.totalCostUsd === prePhaseScope.snapshot().totalCostUsd + debaterScope.snapshot().totalCostUsd + resolverScope.snapshot().totalCostUsd + verifierScope.snapshot().totalCostUsd`
- `runner.ts` no longer reads `prePhaseResult.costUsd` or `verifierResult.costUsd` (the local `totalCostUsd` accumulator is deleted)
- **Codebase invariant:** after this story, `grep -nE "totalCostUsd\\s*\\+=|let\\s+totalCostUsd" src/debate/` returns zero matches across all three runners (`runner-stateful.ts`, `runner-hybrid.ts`, `runner.ts`)
- A follow-up issue is filed (referenced in the PR description) tracking removal of the now-unread `prePhaseResult.costUsd` and `verifierResult.costUsd` return fields from their respective modules

---

### US-007: Document always-on cost flow in `retry-strategy.md` + `adapter-wiring.md`

#### Scope

Update the project-rule documents so future contributors understand: (a) cost recording is always-on infrastructure; (b) leaf code (selectors, debater closures) is cost-blind; (c) attribution comes from `scopeId` set by the orchestration layer that owns the region.

#### Context Files

- `.claude/rules/retry-strategy.md` — current text codifies "Success-path cost is not merged into O" as intentional; rewrite to point at the scope API
- `.claude/rules/adapter-wiring.md` — add the scope pattern to the layer table; document the cost-blind-leaves principle
- `.claude/rules/forbidden-patterns.md` — add forbidden-pattern rows for callback-style cost channels and for selectors returning cost
- `docs/architecture/agent-adapters.md` §14 — referenced by `adapter-wiring.md`; verify consistency

#### Acceptance Criteria

- `.claude/rules/retry-strategy.md` "Success-path cost" subsection is rewritten to state: cost flows only through the `DispatchEvent` → cost middleware → `CostAggregator` path; callers needing per-region cost use `costAggregator.openScope()` and stamp `CallContext.scopeId`
- `.claude/rules/retry-strategy.md` no longer contains the string `accumulatedRunCostUsd`
- `.claude/rules/adapter-wiring.md` documents that the agent adapter exposes 4 primitives and gains no cost-reporting surface; the section explicitly forbids new fields on `CallContext` whose purpose is to surface result-side data, and states that leaf code (selectors, debater closures) MUST stay cost-blind
- `.claude/rules/forbidden-patterns.md` adds a row: `❌ Selector / debater / leaf code that returns or accumulates cost (e.g. SelectorResult.resolverCostUsd, let totalCostUsd = 0) | ✅ Orchestration layer opens a CostAggregator scope and stamps CallContext.scopeId; leaf code stays cost-blind`
- `.claude/rules/forbidden-patterns.md` adds a row: `❌ New "callback-style" output channels on CallContext (e.g. onCostAccumulated, onTokenObserved) | ✅ Read via CostAggregator scope or define an Operation that returns the value as part of O`

## File Format

No new file format introduced. `CostEvent` JSONL drain shape gains one optional field:

```json
{
  "ts": 1715817600000,
  "runId": "run-abc",
  "agentName": "claude",
  "model": "unknown",
  "stage": "review",
  "storyId": "US-042",
  "callId": "ltf6h2-9k3jp1",
  "tokens": { "input": 1200, "output": 340 },
  "estimatedCostUsd": 0.0048,
  "costUsd": 0.0048,
  "confidence": "estimated",
  "durationMs": 2310
}
```

`callId` is omitted when absent — JSONL consumers must treat missing as "unattributed."

## Failure Modes

- **Aggregator unavailable / disabled (`createNoOpCostAggregator`)** → `openScope` returns a handle whose `snapshot()` always returns `EMPTY_SNAPSHOT`. Callers see `resolverCostUsd: 0`. Fail-open; never throws.
- **Cost middleware not attached** → no `CostEvent`s are recorded; scope snapshots return zero. Same fail-open semantics as today.
- **Open scope leak (caller forgets `close()`)** → memory grows by one entry per leaked scope per run. `drain()` logs `warn` with the count. Not a correctness bug; the indexed events still drain.
- **`callId` collision** → totals for the two invocations merge. Detection is not implemented (statistically infeasible at 1 collision per ~2^36 calls in a single run); if it occurs, both invocations see an inflated `resolverCostUsd`.
- **`callOp` invoked from a context without `runtime.costAggregator`** → impossible by construction (runtime always carries one, even if no-op); no defensive branch required.
- **Caller passes their own `callId` on `CallContext`** → `callOp` respects it (`ctx.callId ?? newCallId()`). Enables advanced patterns (e.g. grouping multiple `callOp` invocations into one scope). Not exercised by debate code in this spec.

## Out of Scope

- Reworking how the **exact** vs **estimated** confidence flag is exposed at scope level (current `CostSnapshot` only carries totals; scope `snapshot()` follows the same shape).
- Per-stage cost budgets / kill-switches built on top of scope reads.
- Migrating `OperationCompletedEvent.totalCostUsd` calculation — it remains computed inside `runWithFallback` and is not the cost-attribution surface for op callers.
- Any change to `DebateResult.totalCostUsd` semantics; the field still represents the sum of debater + resolver costs.
- CLI / TUI surfacing of per-call cost (the scope API enables it, but no UI work is in this spec).
