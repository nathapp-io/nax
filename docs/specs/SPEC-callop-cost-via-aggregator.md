# SPEC: Surface callOp cost via CostAggregator scopes (replace `onCostAccumulated` side channel)

**Issues:** #1035, #1036
**Related ADRs:** ADR-019 (Operation layer), ADR-020 (DispatchBoundary SSOT)
**Status:** Draft

---

## Summary

Replace the `CallContext.onCostAccumulated` callback — a side-channel surfaced into the operation layer by the quick fixes for #1035 and #1036 — with a query API on `CostAggregator`. Callers that need per-op cost (debate selectors, debate runners) open a **cost scope** tagged with a per-call correlation id; the scope reads from the existing dispatch-event bus and reports the canonical cost for events recorded inside it. `callOp` stops carrying a cost output channel; agent adapters remain primitive; `DispatchEvent` → cost middleware → `CostAggregator` becomes the single, authoritative flow for cost.

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

Add a **per-call correlation id** (`callId`) onto the dispatch base event, stamp it at the `callOp` boundary (the only site that knows "this is one op invocation"), and add a scope API on `CostAggregator` that filters by `callId`. Callers wrap their `callOp` invocation in a scope and read `.snapshot()` at the end. The callback disappears.

```
┌─────────────┐   stamps callId    ┌──────────────┐   emits DispatchEvent(callId)    ┌────────────┐
│   callOp    │ ──────────────────▶│ AgentManager │ ────────────────────────────────▶│ DispatchBus│
└─────────────┘                    └──────────────┘                                  └─────┬──────┘
                                                                                           │
                                                                              attachCostSub│scriber
                                                                                           ▼
                                                                                  ┌────────────────┐
                                                                                  │ CostAggregator │
                                                                                  │   .byCall(id)  │
                                                                                  └────────┬───────┘
                                                                                           │
            ┌──────────────────────────────────────────────────────────────────────────────┘
            │                          snapshot
            ▼
  ┌─────────────────────┐
  │ judgeSelector / etc │
  │   reads cost here   │
  └─────────────────────┘
```

The cost-on-the-bus path is unchanged. We add a tag (`callId`) and a filter (`byCall`).

### New types

```typescript
// src/runtime/dispatch-events.ts
export interface DispatchEventBase {
  // ... existing fields ...
  /**
   * Per-callOp correlation id stamped by the operation layer. Optional because
   * legacy non-op dispatch sites (debate manager fan-out historical paths)
   * may not stamp it. When absent, the event is not attributable to any scope
   * and contributes to global totals only.
   */
  readonly callId?: string;
}

export interface DispatchErrorEvent {
  // ... existing fields ...
  readonly callId?: string;
}

export interface OperationCompletedEvent {
  // ... existing fields ...
  readonly callId?: string;
}
```

```typescript
// src/runtime/cost-aggregator.ts
export interface CostScopeHandle {
  /** The callId this scope filters by. */
  readonly callId: string;
  /** Totals across events recorded with this scope's callId at the time of call. */
  snapshot(): CostSnapshot;
  /**
   * Releases internal indexes for this scope. Idempotent. Always call in a
   * finally — leaking scopes is a slow memory leak but not a correctness bug.
   */
  close(): void;
}

export interface ICostAggregator {
  // ... existing methods ...
  /** Per-call totals (groups events by `callId`; events without a callId are excluded). */
  byCall(): Record<string, CostSnapshot>;
  /**
   * Opens a scope whose snapshot() returns totals for events recorded under
   * `callId`. When `callId` is omitted the aggregator generates one via the
   * shared `newCallId()` helper and exposes it on `handle.callId`.
   */
  openScope(callId?: string): CostScopeHandle;
}
```

```typescript
// src/operations/call.ts — internal helper, sole producer of callIds
function newCallId(): string {
  // ≤16 chars, monotonic-ish: `${ts.toString(36)}-${random6}`
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
```

`newCallId` lives in `src/operations/call.ts` and is the only generator. `CostAggregator.openScope()` reuses it via a small internal import; callers never invoke it directly — they either supply their own id or read `scope.callId` after `openScope()`.

### Flow

1. `callOp` generates a fresh `callId` at entry (one per invocation, shared across retry attempts within that invocation).
2. `callOp` threads `callId` through to:
   - `agentManager.completeAs(agent, prompt, { ...completeOptions, callId })` for complete-kind.
   - `runOptions.callId` for run-kind (consumed by `buildHopCallback` / `runWithFallback`).
3. The session/manager layers carry `callId` into the `DispatchEvent` they emit (`emitDispatch`, `emitDispatchError`, `emitOperationCompleted`).
4. `attachCostSubscriber` writes `callId` onto the `CostEvent` it forwards to `CostAggregator`.
5. `CostAggregator.openScope(callId).snapshot()` returns the canonical totals (using `costUsd`, i.e. `exactCostUsd ?? estimatedCostUsd`).

### Caller pattern

```typescript
// src/debate/selectors/judge.ts (after migration)
export const judgeSelector: Selector = async (ctx) => {
  const scope = ctx.callContext.runtime.costAggregator.openScope();
  try {
    const output = await callOp(
      { ...ctx.callContext, callId: scope.callId },
      judgeOp,
      { ... },
    );
    return {
      outcome: output.trim() ? "passed" : "failed",
      output,
      resolverCostUsd: scope.snapshot().totalCostUsd,
    };
  } finally {
    scope.close();
  }
};
```

If the caller does not need cost, it omits the scope entirely — no overhead, no callback to thread.

### Removed surface

- `CallContext.onCostAccumulated` — deleted from `src/operations/types.ts`.
- Both write sites in `src/operations/call.ts:153, :422` — deleted.
- Mutable `let resolverCostUsd = 0` / `let totalCostUsd = 0` accumulators in:
  - `src/debate/selectors/judge.ts`
  - `src/debate/selectors/synthesis.ts`
  - `src/debate/runner-stateful.ts`
  - `src/debate/runner-hybrid.ts`

### Failure handling

- **Scope opened but `callOp` throws before any dispatch event fires** → `snapshot()` returns `EMPTY_SNAPSHOT` (cost zero). Correct: no work was done.
- **Scope never closed** → events accumulate against the callId in the aggregator's internal index until the run ends. No correctness impact; small memory leak. Logged as warn from `CostAggregator.drain()` if any open scopes remain at drain time.
- **`callId` collision** (vanishingly unlikely given timestamp+random) → totals merge. Acceptable; the dimension is debug/attribution, not accounting.
- **Legacy callers still passing `onCostAccumulated`** → compile error after the field is removed; this is a hard cut, not a soft deprecation, because every consumer is in `src/debate/` and migrates in the same PR.

### Approach choices considered and rejected

| Alternative | Why rejected |
|:---|:---|
| Wrap `callOp` return in `{ output, costUsd }` envelope | Every caller pays the type-shape cost, even ones that don't care. `Promise<O>` is the contract ADR-019 fought for. |
| Read cost from `aggregator.byStage()` or `byStory()` and subtract before/after | Race-prone under concurrent dispatch (debate fans out per agent in parallel). Correlation id is the deterministic primitive. |
| Emit a new event kind (`CostObservedEvent`) | Duplicates `DispatchEvent` which already carries cost. New event ≠ new information. |
| Have `callOp` consult the aggregator internally and return `{ output, callId }` | Hides the read inside the op layer; selectors still need to know the callId to query. Net surface area is the same. |
| Add `runtime.withCostScope(fn)` higher-order wrapper | Loses precision: a scope can wrap multiple `callOp` calls only if every one stamps the same callId. The id belongs on the invocation, not the wrapper. |

## Stories

1. **US-001: Normalize `exactCostUsd` — make required, fall back to `estimatedCostUsd`** — depends on nothing
2. **US-002: Add `callId` to dispatch event base + stamp at callOp** — depends on nothing (parallelizable with US-001)
3. **US-003: Aggregator scope API (`openScope`, `byCall`)** — depends on US-001 + US-002
4. **US-004: Remove `onCostAccumulated`; migrate debate selectors (`judge`, `synthesis`)** — depends on US-003
5. **US-005: Migrate debate runners (`runner-stateful`, `runner-hybrid`) to scope API** — depends on US-003
6. **US-006: Update `retry-strategy.md` + `adapter-wiring.md` to document the scope-only cost flow** — depends on US-004 + US-005

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

### US-002: Add `callId` to dispatch event base + stamp at callOp

#### Scope

Add an optional `callId` field to `DispatchEventBase`, `DispatchErrorEvent`, and `OperationCompletedEvent`. Stamp a fresh callId at the entry of `callOp` and thread it through `agentManager.completeAs` (complete-kind) and `runOptions` (run-kind) so it lands on every emitted dispatch event for that invocation.

#### Context Files

- `src/runtime/dispatch-events.ts` — event interface SSOT (extend `DispatchEventBase`)
- `src/operations/call.ts` — stamp callId; thread into `completeOptions` (complete-kind) and `runOptions` (run-kind)
- `src/agents/manager.ts` — `completeAs` / `runWithFallback` must accept and forward callId into emitted events
- `src/runtime/session-run-hop.ts` — `runAsSession` event emission site
- `docs/adr/ADR-020-dispatch-boundary-ssot.md` §D1 — "new cross-cutting fields go on `DispatchEventBase`" precedent

#### Acceptance Criteria

- `DispatchEventBase`, `DispatchErrorEvent`, and `OperationCompletedEvent` each declare `readonly callId?: string`
- `callOp(ctx, op, input)` generates one fresh callId per invocation via an internal `newCallId()` helper in `src/operations/call.ts` that returns a string of ≤16 chars matching `/^[0-9a-z]+-[0-9a-z]+$/`
- For `kind:"complete"` ops, the `CompleteDispatchEvent` emitted by `agentManager.completeAs` carries `callId` equal to the invocation's stamped id
- For `kind:"run"` ops, every `SessionTurnDispatchEvent` emitted during the invocation carries the same `callId`
- When `callOp` retries via `op.retry`, every dispatch event across retry attempts within one `callOp` invocation carries the same `callId`
- `DispatchErrorEvent` emitted from a failed `callOp` dispatch carries the same `callId` as the failed attempt
- `OperationCompletedEvent` emitted by `runWithFallback` for a `callOp` invocation carries that invocation's `callId`
- `newCallId()` returns a distinct value on each call (10,000 sequential calls produce 10,000 distinct ids in the test)

---

### US-003: Aggregator scope API (`openScope`, `byCall`)

#### Scope

Extend `CostAggregator` with `byCall(): Record<string, CostSnapshot>` and `openScope(callId: string): CostScopeHandle`. Update `attachCostSubscriber` to copy `event.callId` onto the `CostEvent` it records. Implement scope as a thin index that filters in-memory events.

#### Context Files

- `src/runtime/cost-aggregator.ts` — extend `ICostAggregator` and `CostAggregator`, add `CostScopeHandle`
- `src/runtime/middleware/cost.ts` — forward `event.callId` onto the constructed `CostEvent`
- `src/runtime/index.ts` — surface the aggregator on `NaxRuntime` (already exists; verify barrel export of new types)
- `test/unit/runtime/cost-aggregator.test.ts` — existing aggregator tests; mirror structure for new methods

#### Acceptance Criteria

- `CostEvent` declares `readonly callId?: string`, and `attachCostSubscriber` sets `costEvent.callId = event.callId` (leaving it undefined when the source event has none)
- `CostAggregator.byCall()` returns a `Record<string, CostSnapshot>` keyed by `callId`, including only events where `callId !== undefined`
- `CostAggregator.openScope(callId)` returns a `CostScopeHandle` whose `callId` field equals the input; `openScope()` (no arg) generates one via the shared `newCallId()` and exposes it on `handle.callId`
- `CostScopeHandle.snapshot()` returns a `CostSnapshot` reflecting only `CostEvent`s recorded with `e.callId === handle.callId` at the time `snapshot()` is called
- `CostScopeHandle.snapshot()` aggregates `costUsd` (the canonical exact-equals-required field after US-001) into `CostSnapshot.totalCostUsd`, matching the per-event accumulator used by global `snapshot()`
- `CostScopeHandle.snapshot()` returns `EMPTY_SNAPSHOT` when no events with the scope's `callId` have been recorded
- `CostScopeHandle.close()` is idempotent (second call is a no-op); after `close()`, `snapshot()` returns the totals frozen at the time of the first `close()` call
- `CostAggregator.drain()` logs at level `warn` with `{ openScopeCount: number }` when any scope is still open at drain time, but completes successfully

---

### US-004: Remove `onCostAccumulated`; migrate debate selectors (`judge`, `synthesis`)

#### Scope

Delete `CallContext.onCostAccumulated` and both write sites in `callOp`. Migrate `judgeSelector` and `synthesisSelector` to open a scope, pass `callId` on the `CallContext` they hand to `callOp`, and read `resolverCostUsd` from `scope.snapshot().totalCostUsd`.

#### Context Files

- `src/operations/types.ts` — remove `onCostAccumulated` field
- `src/operations/call.ts` — remove both `ctx.onCostAccumulated?.(...)` calls in the complete-kind and run-kind success paths
- `src/debate/selectors/judge.ts` — current callback-based pattern (lines 24-30)
- `src/debate/selectors/synthesis.ts` — same pattern (lines 25-30)
- `src/debate/selectors/types.ts` — `SelectorResult.resolverCostUsd` shape (unchanged)
- `test/unit/debate/selectors/judge.test.ts`, `test/unit/debate/selectors/synthesis.test.ts` — cost-parity regression tests must continue to assert real cost

#### Acceptance Criteria

- `CallContext` does not declare `onCostAccumulated`, and `src/operations/call.ts` contains no reference to it
- `CallContext` declares `readonly callId?: string`; `callOp` uses `ctx.callId ?? newCallId()` and never overwrites a caller-supplied value
- `judgeSelector` opens a `CostScopeHandle` (via `runtime.costAggregator.openScope()`) before invoking `callOp` and calls `handle.close()` in a `finally` block
- `judgeSelector` returns `resolverCostUsd` equal to `handle.snapshot().totalCostUsd` after the `callOp` invocation completes
- `synthesisSelector` follows the same pattern as `judgeSelector` (scope open → `callOp` with `callId: scope.callId` → `snapshot` → `close`)
- When a `callOp` invocation under `judgeSelector` emits two dispatch events with `estimatedCostUsd = 0.04` each, the returned `resolverCostUsd` equals `0.08`
- When `callOp` throws before any dispatch event fires, `judgeSelector` propagates the throw and the scope is closed by the `finally`

---

### US-005: Migrate debate runners (`runner-stateful`, `runner-hybrid`) to scope API

#### Scope

Replace `onCostAccumulated`-based accumulators in `runner-stateful.ts` and `runner-hybrid.ts` with per-debater scopes. Each `debaterCallContext(agentName, index)` opens its own scope; `totalCostUsd` is the sum of `scope.snapshot().totalCostUsd` across all debaters after `Promise.allSettled` resolves.

#### Context Files

- `src/debate/runner-stateful.ts` — `debaterCallContext` factory and `totalCostUsd` accumulator
- `src/debate/runner-hybrid.ts` — same pattern
- `src/debate/session-helpers.ts` — `resolverCostUsd` field on outcome (shape unchanged)
- `test/unit/debate/runner-hybrid-rebuttal.test.ts` — existing per-turn cost test must continue to pass against the scope-based path

#### Acceptance Criteria

- Neither `runner-stateful.ts` nor `runner-hybrid.ts` references `onCostAccumulated`
- `debaterCallContext(agentName, index)` returns a `CallContext` whose `callId` is unique per debater invocation (via `openScope().callId`)
- `runStateful` returns `DebateResult.totalCostUsd` equal to the sum of every per-debater scope's `snapshot().totalCostUsd` plus `selectorResult.resolverCostUsd`
- `runHybrid` returns `DebateResult.totalCostUsd` equal to the sum of every per-debater scope's `snapshot().totalCostUsd` plus `resolveResult.resolverCostUsd`
- Every per-debater scope is closed regardless of whether the corresponding `callOp` resolves or rejects (verified by an `allSettled` + `finally` shape)
- When two debaters each emit one dispatch event with `estimatedCostUsd = 0.05`, `totalCostUsd` reflects `0.10` plus the resolver cost

---

### US-006: Document scope-only cost flow in `retry-strategy.md` + `adapter-wiring.md`

#### Scope

Update the two project-rule documents that currently codify the `onCostAccumulated` decision so future contributors do not re-introduce a side channel.

#### Context Files

- `.claude/rules/retry-strategy.md` — current text codifies "Success-path cost is not merged into O" as intentional; update to point at the scope API
- `.claude/rules/adapter-wiring.md` — adds the scope pattern to the layer table
- `.claude/rules/forbidden-patterns.md` — add a forbidden-pattern row for `onCostAccumulated` to block re-introduction
- `docs/architecture/agent-adapters.md` §14 — referenced by `adapter-wiring.md`; verify consistency

#### Acceptance Criteria

- `.claude/rules/retry-strategy.md` "Success-path cost" subsection is rewritten to state: cost flows only through the `DispatchEvent` → cost middleware → `CostAggregator` path; callers needing per-op cost use `costAggregator.openScope(callId)`
- `.claude/rules/retry-strategy.md` no longer contains the string `accumulatedRunCostUsd`
- `.claude/rules/adapter-wiring.md` documents that the agent adapter exposes 4 primitives and gains no cost-reporting surface; the section explicitly forbids new fields on `CallContext` whose purpose is to surface result-side data
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
