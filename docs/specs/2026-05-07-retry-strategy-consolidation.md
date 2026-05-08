# Retry Strategy Consolidation

**Status:** Resolved
**Date:** 2026-05-07
**Owners:** TBD
**Related:** Issue #856 (RetryStrategy framework introduction), [.claude/rules/retry-strategy.md](../../.claude/rules/retry-strategy.md), [src/agents/retry/](../../src/agents/retry/), [src/runtime/middleware/idle-watchdog.ts](../../src/runtime/middleware/idle-watchdog.ts)

## Resolution: retry-as-hop (2026-05-08)

`op.retry` and `op.hopBody` now compose. When only `op.retry` is set, `callOp` synthesizes a hop body that runs the parse-retry loop inside one session. When both are set, the user-supplied body receives `ctx.sendWithParseRetry` — a `send` variant with the parse-retry loop baked in. `semanticReviewOp` is the canonical example: `op.retry` handles JSON parse retries (two attempts, `jsonRetry` / `jsonRetryCondensed`); `op.hopBody` handles requote enrichment using the validated turn output.

`src/operations/_review-retry.ts` (`makeReviewRetryHopBody`) has been deleted. The mutual-exclusion guard (`OP_HOPBODY_RETRY_BOTH_SET`) has been removed. The forbidden-patterns table now bans hand-rolled parse-retry loops inside `op.hopBody` rather than banning coexistence.

See [docs/specs/2026-05-08-retry-as-hop-implementation-plan.md](./2026-05-08-retry-as-hop-implementation-plan.md) for the full design and implementation notes.

## Summary

Unify three retry mechanisms — manager-tier transient retry, op-tier complete-call retry, and op-tier intra-session parse retry (the `HopBody` in semantic/adversarial review) — under a single `RetryStrategy` interface. Add the op-tier slot to `RunOperation` (currently only on `CompleteOperation`). Support multiple strategies per op via a `composeRetry` combinator rather than a list-typed field. Keep the watchdog mechanism as-is at the manager tier — it already routes through `defaultRetryStrategy` via `fail-stale` and applies universally to every dispatch.

## Problem

Today nax has three retry surfaces that look different to readers but solve the same shape of problem:

1. **Agent watchdog → manager retry.** [src/runtime/middleware/idle-watchdog.ts](../../src/runtime/middleware/idle-watchdog.ts) cancels idle calls; the cancel emits `fail-stale`; `defaultRetryStrategy` retries the call. This already works through `RetryStrategy`. (Watchdog's own internal `cancelAttempts` counter is "how many times to keep cancelling a stuck call," not "how many times to retry the failed call" — out of scope here.)
2. **Op-tier transient retry on complete.** `CompleteOperation.retry` accepts `RetryPreset | RetryStrategy | resolver`. Used by ops that classify routes, parse JSON, etc.
3. **Intra-session parse retry on run.** [src/operations/_review-retry.ts](../../src/operations/_review-retry.ts) — semantic and adversarial review use `HopBody` to send a *different* prompt on JSON parse failure (`jsonRetry` vs `jsonRetryCondensed`).

`RunOperation` has no op-tier `retry` slot today, so #3 lives outside the unified framework — it's modelled as a session continuation rather than a retry. The current rule in [.claude/rules/retry-strategy.md](../../.claude/rules/retry-strategy.md) explicitly excludes `HopBody` from the retry framework because the existing `RetryDecision` cannot transform the next prompt:

> `HopBody` callbacks on `RunOperation` are multi-turn session continuations, not single-call retries. Do not express them as `RetryStrategy`.

The exclusion was correct for the interface as written. With one small extension — an optional `nextPrompt` on `RetryDecision` — `HopBody` parse-retries collapse into the same model as transport retries, and op authors get one mental model and one declarative slot per op.

## Goals

- One `RetryStrategy` interface used by all three sites.
- Op authors declare retry behavior via `op.retry` on both `RunOperation` and `CompleteOperation`.
- Multiple distinct retry concerns on a single op compose explicitly via `composeRetry([...])`.
- Manager-tier defaults (rate-limit, stale) remain implicit and universal — no per-op opt-in.
- The semantic/adversarial parse retry moves from `HopBody` to `op.retry` with no behavioral change.

## Non-goals

- Refactoring the watchdog itself. Its internal cancel-attempts counter and stream-event loop stay.
- Changing how `defaultRetryStrategy` decides what to retry. It already covers `fail-rate-limit` + `fail-stale`.
- Removing `HopBody` entirely. It remains the right abstraction for multi-turn session continuations that are *not* retries (e.g. genuinely conversational flows). Only the parse-retry use case migrates.
- Generalizing watchdog `maxRetryAttempts` (cancel attempts) into `RetryStrategy`. It's a different counter answering a different question.
- New config keys. The existing `routing.llm.retries` / `retryDelayMs` deprecation bridge stays as-is.

## Design

### Two-tier composition (unchanged conceptually)

```
manager.retry            ← defaultRetryStrategy: rate-limit + stale, universal
  └─ op.retry            ← per-op declared, opt-in (this proposal adds the slot to RunOperation)
      └─ adapter call
```

The manager tier wraps every dispatch. The op tier fires on the inner call's failure before the manager tier sees it. Each layer follows the existing convention: *return `{ retry: false }` for failures you don't own*, and the next layer up takes over.

### Interface change — extend `RetryDecision`

Add an optional `nextPrompt`:

```typescript
// src/agents/retry/types.ts
export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number; nextPrompt?: string };
```

Strategies that don't need to transform the prompt simply omit `nextPrompt`. The transport-style strategies (`defaultRetryStrategy`, `resolveRetryPreset`) are unaffected.

### Interface change — enrich `RetryContext`

Parse-retry strategies need access to the last output and (optionally) the parser's result so they can pick the right retry prompt (e.g. condensed-vs-standard based on truncation hint).

```typescript
// src/agents/retry/types.ts
export interface RetryContext {
  readonly site: "run" | "complete";
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly lastOutput?: string;       // full output of the failed attempt
  readonly lastParsed?: unknown;      // parser result, if parse was attempted
  readonly lastTurnResult?: TurnResult; // for strategies that need cost/usage context
}
```

Fields are optional so existing strategies and call sites remain valid.

### Interface change — add `retry` slot to `RunOperation`

```typescript
// src/operations/types.ts
export interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  // ... existing fields ...
  readonly retry?: RetryPreset | RetryStrategy | ((input: I, ctx: BuildContext<C>) => RetryPreset | RetryStrategy | undefined);
}
```

Same shape as `CompleteOperation.retry`. The resolver form returns either a `RetryPreset` or a fully-formed `RetryStrategy` — the latter lets ops compose multiple strategies via `composeRetry`.

### New combinator — `composeRetry`

Multiple distinct concerns chain via a single combinator. The `op.retry` field stays typed as one `RetryStrategy` (no list-typed field, no special-case parsing in `callOp`).

```typescript
// src/agents/retry/compose.ts
export function composeRetry(strategies: readonly RetryStrategy[]): RetryStrategy {
  return {
    shouldRetry(failure, attempt, ctx) {
      for (const s of strategies) {
        const d = s.shouldRetry(failure, attempt, ctx);
        if (d.retry) return d;   // first match wins
      }
      return { retry: false };
    },
  };
}
```

**Semantics: first match wins.** Order matters — the op author lists most specific first. Each strategy is single-purpose and ignores failures outside its remit by returning `{ retry: false }`. Once any strategy votes to retry, later strategies are not consulted (no delay-merging, no decision-merging).

### New strategy factory — `makeParseRetryStrategy`

Replaces `makeReviewRetryHopBody`. Same shape, returns a `RetryStrategy` instead of a `HopBody`.

```typescript
// src/agents/retry/parse-retry.ts
export interface ParseRetryOpts {
  readonly validate: (parsed: unknown) => boolean;
  readonly reviewerKind: string;                  // for logging
  readonly maxAttempts?: number;                  // default 2 (one retry, matches today)
  readonly prompts: {
    readonly invalid: () => string;
    readonly truncated: () => string;
  };
  readonly looksTruncated?: (output: string) => boolean;  // default: looksLikeTruncatedJson
}

export function makeParseRetryStrategy(opts: ParseRetryOpts): RetryStrategy { /* ... */ }
```

Internally:
- Reads `ctx.lastOutput` to decide which prompt variant to use.
- Returns `{ retry: true, delayMs: 0, nextPrompt }` on first parse failure.
- Returns `{ retry: false }` on subsequent attempts (or when failure is not a parse-shape failure — e.g. transport errors fall through to the manager tier).

### Two patterns, one model

| Need | Pattern |
|:---|:---|
| Different failure types, each with own logic | `composeRetry([parseRetry, transientNetwork])` |
| Same failure type, escalating attempts (progressive prompt) | One strategy, branch on `attempt` inside `shouldRetry` |
| Universal infra (rate-limit, stale) | Manager tier — no op opt-in |

### How `callOp` consumes `RunOperation.retry`

Current `callOp` already wires `CompleteOperation.retry` into a retry loop bounded by `MAX_COMPLETE_RETRY_ATTEMPTS`. The same loop wraps the run-kind dispatch. When `nextPrompt` is set in the decision, the next attempt sends that prompt instead of rebuilding from `op.build(input, ctx)`.

Important constraints:
- The retry loop sits *inside* the same session for run-kind ops (matches today's `HopBody` semantics — same session, different prompt).
- `_callOpDeps.sleep(decision.delayMs, ctx.runtime.signal)` is used uniformly — no `Bun.sleep` in retry loops.
- Manager-tier `defaultRetryStrategy` continues to wrap everything — op-tier is the inner loop.

### Structured logging on every retry

`callOp` emits a structured log line on every retry decision (both run-kind and complete-kind), so retries are visible in JSONL traces without each strategy logging independently. Strategies may add their own context-specific logs on top, but the canonical "we retried" event lives in `callOp`.

Log shape (warn level, stage prefix `callop`):

```typescript
logger.warn("callop", "Op retrying", {
  storyId: ctx.storyId,
  opName: op.name,
  site: "run" | "complete",
  agentName: ctx.agentName,
  stage: op.stage,
  attempt,                   // zero-based, matches RetryStrategy contract
  delayMs: decision.delayMs,
  promptTransformed: decision.nextPrompt !== undefined,
  failureKind: failure instanceof Error ? "error" : (failure as AdapterFailure).outcome,
  failureMessage: errorMessage(failure),
});
```

When the op exhausts its retry budget and `MAX_COMPLETE_RETRY_ATTEMPTS` is hit, `callOp` also emits an `error`-level `Op retry budget exhausted` log with the same fields plus `totalAttempts`. This makes parallel-mode retry behavior auditable without spelunking through individual strategy implementations.

Log fields follow the project rule: `storyId` first in the data object.

## Migration

### Phase 1 — interface and combinator

1. Extend `RetryDecision` with optional `nextPrompt`.
2. Enrich `RetryContext` with optional `lastOutput`, `lastParsed`, `lastTurnResult`.
3. Add `composeRetry` to `src/agents/retry/`.
4. Add `makeParseRetryStrategy` to `src/agents/retry/`.
5. Export new symbols from `src/agents/retry/index.ts`.
6. Update [.claude/rules/retry-strategy.md](../../.claude/rules/retry-strategy.md) — remove the "What NOT to convert" exclusion for parse retries; replace with guidance on when to use `composeRetry` vs single-strategy escalation.

No behavioral change yet. All existing `RetryDecision` consumers stay valid because the new fields are optional.

### Phase 2 — `RunOperation.retry` slot

1. Add the `retry?` field to `RunOperation` in `src/operations/types.ts`.
2. Extend `callOp`'s run-kind path to honor `op.retry` — same shape as the complete-kind retry loop, with the addition of feeding `nextPrompt` into the next `send` instead of re-running `op.build`.
3. Thread `lastOutput` / `lastParsed` into `RetryContext` from the inner loop.
4. Emit `callop "Op retrying"` warn log on every retry decision; emit `callop "Op retry budget exhausted"` error log when `MAX_COMPLETE_RETRY_ATTEMPTS` is hit. Apply the same logs to the existing complete-kind retry loop so coverage is uniform across kinds.

No callers affected yet — the new field is optional.

### Phase 3 — migrate semantic + adversarial review

1. Replace [src/operations/_review-retry.ts](../../src/operations/_review-retry.ts) with `makeParseRetryStrategy` consumers in [src/operations/semantic-review.ts](../../src/operations/semantic-review.ts) and [src/operations/adversarial-review.ts](../../src/operations/adversarial-review.ts).
2. Each op replaces `hopBody: makeReviewRetryHopBody(...)` with `retry: makeParseRetryStrategy({ validate, prompts, ... })`.
3. Delete `_review-retry.ts` once both ops migrate.
4. Verify behavior parity:
   - Same parse-success short-circuit (no retry).
   - Same prompt selection (`jsonRetry` vs `jsonRetryCondensed`) via `ctx.lastOutput` + `looksLikeTruncatedJson`.
   - Same cost accumulation across attempts (`callOp` already sums per-attempt cost).
   - Same warning logs (`reviewerKind` flows through strategy options).

### Phase 4 — documentation and CI

1. Update `docs/architecture/agent-adapters.md` and any references in `docs/adr/` that point at `HopBody` for parse retries.
2. Add a forbidden-patterns entry: new `HopBody` parse-retry implementations must use `op.retry` instead.
3. Add tests for `composeRetry` ordering, `nextPrompt` round-trip in `callOp`, and the migrated review ops.

## Testing

| Layer | Test |
|:---|:---|
| `composeRetry` | First-match-wins semantics; empty list returns `{retry:false}`; later strategies skipped after first match. |
| `makeParseRetryStrategy` | Valid output → no retry; invalid + truncated → `nextPrompt = truncated()`; invalid + not truncated → `nextPrompt = invalid()`; second invalid attempt → `{retry:false}`. |
| `callOp` run-kind retry | `nextPrompt` is sent on retry; without `nextPrompt`, original prompt resends; bounded by `MAX_COMPLETE_RETRY_ATTEMPTS`; `sleep` is cancellable via `ctx.runtime.signal`. |
| `callOp` retry logging | `Op retrying` warn log fires once per retry with all fields populated; `Op retry budget exhausted` error log fires on `MAX_COMPLETE_RETRY_ATTEMPTS`; `storyId` is first key; `promptTransformed` reflects `nextPrompt` presence. |
| Semantic / adversarial migration | Parity tests covering parse-success, parse-failure-truncated, parse-failure-invalid, two consecutive failures (no second retry). |
| Manager-tier interaction | Op-tier exhaustion that bubbles up as `fail-stale` triggers manager-tier retry — both layers compose without double-counting. |

## Decisions resolved

- **Composition semantics:** first match wins (no delay-merging, no decision-merging).
- **Retry logging:** `callOp` emits structured `Op retrying` warn logs per retry and `Op retry budget exhausted` error log on max-retries — applied uniformly across run-kind and complete-kind.
- **Naming:** keep `makeParseRetryStrategy` (mirrors the existing `makeReviewRetryHopBody` it replaces).

## Risks

- **Behavioral drift in review ops.** Mitigation: parity tests in Phase 3 covering all four parse-failure paths from `_review-retry.ts`.
- **Confusion between `HopBody` and `op.retry`.** Both can in principle send multiple prompts in one session. Rule: `HopBody` for genuine multi-turn flows that aren't reactions to failure; `op.retry` for "the call failed, try again with a (possibly different) prompt." Document this in the rules file.
- **Manager + op double-retry on the same failure type.** Strategies that overlap (e.g. an op-level strategy that also handles `fail-stale`) would retry the call once at op tier and once at manager tier. Mitigation: convention enforced by code review and rule documentation — op-tier strategies must not handle `fail-rate-limit` or `fail-stale`; those belong to the manager tier.

## Out of scope (future work)

- Watchdog `cancelAttempts` modeled as a `RetryStrategy`. Different concern (how aggressively to chase a stuck process), different counter semantics.
- Per-op rate-limit overrides at the op tier. Today rate-limit is a manager-tier universal concern; no demand surfaced for per-op tuning.
- Telemetry hook on retry attempts (events, metrics).
