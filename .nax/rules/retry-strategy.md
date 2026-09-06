---
priority: 45
appliesTo:
  - "src/agents/**/*.ts"
  - "src/operations/**/*.ts"
  - "src/routing/**/*.ts"
  - "src/pipeline/**/*.ts"
  - "src/execution/**/*.ts"
stages:
  - "context"
  - "execution"
  - "tdd-implementer"
  - "rectify"
  - "autofix"
  - "single-session"
  - "tdd-simple"
  - "no-test"
  - "batch"
---

# Retry Strategy

> Introduced in issue #856. SSOT: `src/agents/retry/`.

All retry logic in nax is expressed through the `RetryStrategy` interface — no inline retry loops, no hardcoded delay constants, no `while (true)` with a counter elsewhere in the codebase.

## Scope: dispatch tiers only

This rule governs nax's **dispatch** tiers — the layers that decide whether to
re-dispatch a call. It does not govern **agent-internal** retry, which re-issues
a single call from inside the agent's own execution of it, below any dispatch
decision, and has never been a `RetryStrategy`:

- **ACP** — `agent.acp.promptRetries` is passed to acpx as `--prompt-retries`.
  The retry runs inside the spawned claude / codex / opencode process, outside
  nax entirely.
- **Native** — there is no child process; nax is the agent. The same layer
  therefore lives in nax, in `src/agents/native/session/turn-retry.ts`
  (nax#1870), and its loop is the sanctioned execution site for that layer.

So `turn-retry.ts` is ACP parity, not a third tier and not a violation of the
line above. Anything that decides whether to re-dispatch a call still belongs
behind `RetryStrategy`.

## Two-tier model

| Tier | Site | Default | Override |
|:---|:---|:---|:---|
| **Manager** | `AgentManager.runWithFallback` (site #1) | `defaultRetryStrategy` — rate-limit only, 3 retries, 2s/4s/8s exponential | Pass `retryStrategy` to `AgentManager` constructor via `_agentManagerDeps` injection |
| **Op** | `callOp` run-kind and complete-kind (site #2) | none — throws on first parse failure; complete-kind throws on first call failure | Declare `retry` on `RunOperation` or `CompleteOperation` |

## Declaring retry on a `CompleteOperation`

Use the `retry` field. It accepts three forms:

```typescript
// 1. Declarative preset (most common — configurable at runtime)
retry: (_input, ctx) => ({
  preset: "transient-network" as const,
  maxAttempts: (ctx.config.routing.llm?.retries ?? 1) + 1,
  baseDelayMs: ctx.config.routing.llm?.retryDelayMs ?? 1000,
}),

// 2. Static preset (fixed policy, no config-driven tuning)
retry: {
  preset: "transient-network" as const,
  maxAttempts: 3,
  baseDelayMs: 500,
},

// 3. Custom RetryStrategy (fine-grained control)
retry: {
  shouldRetry(failure, attempt, ctx) {
    if (attempt >= 2) return { retry: false };
    if (failure instanceof Error && failure.message.includes("timeout")) {
      return { retry: true, delayMs: 1000 };
    }
    return { retry: false };
  },
},
```

`callOp` is bounded by `MAX_COMPLETE_RETRY_ATTEMPTS = 20` regardless of the strategy. For complete-kind ops, hitting the ceiling always throws `CALL_OP_MAX_RETRIES`. For run-kind ops with `op.retry`, the ceiling triggers `CALL_OP_MAX_RETRIES` only if the final `op.parse` also fails — graceful-degradation parsers (returning `FAIL_OPEN`-style values) absorb the exhaustion silently. Strategies that may keep retrying indefinitely should self-terminate via `attempt >= maxAttempts`.

## `RetryPreset` semantics

| Field | Meaning |
|:---|:---|
| `preset: "transient-network"` | Retry on any thrown `Error` or `AdapterFailure` where `af.retriable === true` |
| `maxAttempts` | Total call attempts including the first (2 = one retry, 3 = two retries) |
| `baseDelayMs` | Fixed wait between attempts (no backoff) |

`resolveRetryPreset` in `src/agents/retry/presets.ts` converts a `RetryPreset` to a live `RetryStrategy`.

## `defaultRetryStrategy` (manager tier)

Lives in `src/agents/retry/default-strategy.ts`. Fires **only** on `fail-rate-limit` outcome; all other failures pass through immediately. Backoff: `2^(attempt+1) * 1000` ms — 2s, 4s, 8s across 3 retries. Injected into `AgentManager` via the constructor; tests override via `_agentManagerDeps.sleep` + a custom strategy.

## `composeRetry` vs. single-strategy escalation

Use `composeRetry([...])` when different failure types each have independent logic:

```typescript
// Different failure types, each with own logic
retry: composeRetry([
  parseRetry,           // Handles parse errors with internal JSON extraction
  transientNetworkRetry // Handles connection timeouts with exponential backoff
])
```

Use a single strategy with `attempt`-based branching when the same failure type needs escalation:

```typescript
// Same failure type, escalating attempts
retry: {
  shouldRetry(failure, attempt, ctx) {
    if (attempt >= 3) return { retry: false };
    // All retries use same logic; escalation is implicit in attempt count
    if (failure instanceof Error && failure.message.includes("timeout")) {
      return { retry: true, delayMs: 1000 * Math.pow(2, attempt) };
    }
    return { retry: false };
  },
}
```

**Manager-tier concerns:** `fail-rate-limit` and `fail-stale` are universal infrastructure concerns handled by `defaultRetryStrategy` at the manager tier. Op-tier strategies MUST NOT handle these — doing so causes double-retry (op retries, then manager retries again) and confuses failure attribution. If an op-tier strategy needs to handle rate-limits, it is a sign that the concern should move to `defaultRetryStrategy` or be routed through it.

## `HopBody` and `op.retry` — composition semantics

`op.retry` and `op.hopBody` compose; setting both is allowed and encouraged.

- **`op.retry` only** — `callOp` synthesizes a hop body that runs the parse-retry loop inside one session. No user-supplied body needed.
- **`op.hopBody` only** — Multi-turn session continuations. `ctx.sendWithParseRetry` equals `ctx.send` (no retry loop). Used when the operation needs multiple agent turns that are NOT failure reactions.
- **Both set** — The user-supplied body receives `ctx.sendWithParseRetry`, a variant of `send` with the parse-retry loop baked in. Use this when an op needs both retry-on-parse-failure (declarative, via `op.retry`) and post-turn enrichment (imperative, via `op.hopBody`). `semanticReviewOp` is the canonical example: `op.retry` handles JSON parse retries; `op.hopBody` handles requote enrichment using the validated turn output.

Never write a hand-rolled retry loop inside `op.hopBody`. Use `ctx.sendWithParseRetry` instead — the loop is already there.

## Parse-retry-internal-parser convention

`makeParseRetryStrategy` strategies parse output internally (default: `tryParseLLMJson`). Strategies do NOT receive `lastParsed` from `callOp` because parsing is operation- and strategy-specific. `callOp` passes only `lastOutput`, and the strategy decides whether to re-parse, re-format, or change the prompt.

Example usage on a `RunOperation`:

```typescript
import { makeParseRetryStrategy } from "../agents/retry";
import type { RunOperation } from "./types";

export const exampleRunOp: RunOperation<ExampleInput, ExampleOutput, ExampleConfig> = {
  kind: "run",
  name: "example-run",
  stage: "review",
  config: exampleConfigSelector,
  retry: makeParseRetryStrategy({
    validate: (parsed) => parsed !== null && typeof parsed === "object",
    reviewerKind: "example",
    maxAttempts: 3,
    prompts: {
      invalid: () => "The response was not valid JSON. Please re-format as valid JSON.",
      truncated: () => "The response appears truncated. Please provide the complete JSON.",
    },
    parse: (output) => JSON.parse(output),
  }),
  build(input, _ctx) {
    return { prompt: "..." };
  },
};
```

## `RetryDecision.fallback` and `exhaustedFallback`

The `{ retry: false }` variant of `RetryDecision` carries an optional `fallback?: unknown` field:

```typescript
type RetryDecision =
  | { retry: false; fallback?: unknown }
  | { retry: true; delayMs: number; nextPrompt?: string };
```

`makeParseRetryStrategy` surfaces this when its budget is exhausted: if `exhaustedFallback` is provided, its return value is set on `decision.fallback`. `callOp` then returns that value merged with the accumulated cost instead of the raw `TurnResult`.

When `exhaustedFallback` is absent, `callOp` returns the last `TurnResult` as-is (typed as `O`). **Ops that cannot tolerate a raw `TurnResult` as their output MUST provide `exhaustedFallback`.**

**Strict-parser interaction:** when an op's `parse()` throws on unparseable input (e.g. `adversarialReviewOp`), the op MUST use one of three sanctioned escape hatches to avoid `ParseValidationError` propagating to the caller:

1. **`exhaustedFallback`** on the strategy — synchronous, receives `lastOutput`; ideal when a safe degraded value can be synthesised from the agent's last output.
2. **Graceful-degradation `parse()`** — returns a `FAIL_OPEN`-style value instead of throwing (e.g. `semanticReviewOp`).
3. **`op.recover`** — async, receives the full `input` and a `VerifyContext` (file I/O); invoked by `callOp`'s catch path before the envelope passthrough. Ideal for disk-recovery ops that cannot synthesise from `lastOutput` alone (e.g. `planInteractiveOp` re-reads `outputPath` from disk, see issue #993).

`callOp` tries the escape hatches in order: `exhaustedFallback` wins if present on the strategy decision; then `op.recover` if defined and returns non-null; then the last-resort TurnResult passthrough (logged as warn — indicates a missing escape hatch). Graceful parsers make all three optional.

```typescript
// Always provide exhaustedFallback for ops with structured output types
exhaustedFallback: (lastOutput) =>
  /"passed"\s*:\s*false/.test(lastOutput)
    ? { passed: false, findings: [], looksLikeFail: true }
    : FAIL_OPEN,
```

Custom `RetryStrategy` implementations can also set `fallback` on their `{ retry: false }` decision — `callOp` reads it regardless of which strategy produced it.

**Success-path cost:** Cost recording is always-on and flows **only** through the `DispatchEvent` → cost middleware → `CostAggregator` path, never through op output (`O`). Callers needing per-region cost attribution use `costAggregator.openScope()` and stamp `CallContext.scopeId` at the orchestration layer. Leaf code (selectors, debaters, adapters) remains cost-blind. The middleware layer is the sole writer of cost data.

## `ParseValidationError` discrimination

Strategies that handle validation-style failures (JSON parse, schema mismatch) discriminate via `instanceof ParseValidationError`. Strategies that handle transport failures (network timeout, connection reset) ignore this check.

```typescript
// Distinguishing validation vs. transport failures
shouldRetry(failure, attempt, ctx) {
  if (failure instanceof ParseValidationError) {
    // JSON parse failed — potentially fixable with prompt adjustment
    if (attempt < 3) return { retry: true, delayMs: 500 };
  } else if (failure instanceof Error && failure.message.includes("ECONNRESET")) {
    // Network failure — use longer backoff
    if (attempt < 5) return { retry: true, delayMs: 2000 * Math.pow(2, attempt) };
  }
  return { retry: false };
}
```

## `routing.llm.retries` / `retryDelayMs` — deprecation bridge

These config keys are deprecated (issue #856). They are still applied but warn at load time via `applyRoutingRetryDeprecationWarning` in `src/config/loader.ts`. The `classifyRouteOp` / `classifyRouteBatchOp` retry resolvers read them as a bridge until users migrate to op-level retry config. Do not add new readers of these keys.

## Abort-signal threading

`callOp`'s retry sleep is cancellable:

```typescript
await _callOpDeps.sleep(decision.delayMs, ctx.runtime.signal);
```

`_callOpDeps.sleep` uses `cancellableDelay` from `src/utils/bun-deps`. Always thread `ctx.runtime.signal` through; never call `Bun.sleep` directly inside a retry loop.

## Forbidden patterns

| Forbidden | Use Instead |
|:---|:---|
| Inline `while` / `for` retry loops with hardcoded counters | `retry` field on `CompleteOperation`, or `RetryStrategy` injected at construction |
| `while (true)` retry loops | `while (attempt <= MAX_COMPLETE_RETRY_ATTEMPTS)` — or better, declare `retry` on the op |
| Hardcoded `await Bun.sleep(2000)` between attempts | `_callOpDeps.sleep(decision.delayMs, signal)` (testable, cancellable) |
| New readers of `config.routing.llm?.retries` outside `classify-route.ts` | Op-level `retry` resolver reading from config slice |
| `MAX_RATE_LIMIT_RETRIES` constant (deleted) | `defaultRetryStrategy` / `RetryPreset.maxAttempts` |
| Hand-rolled parse-retry loops inside an `op.hopBody` | `ctx.sendWithParseRetry` — declare `op.retry` and call `sendWithParseRetry` in the body |
| Strategy `validate` and `op.parse` having different acceptance criteria | Define a shared validator helper (e.g. `validateLLMShape`) and call it from both |
| Run-kind op with strict (throwing) `parse()` and `op.retry` but no `exhaustedFallback` AND no `op.recover` that returns a non-null value | Provide `exhaustedFallback` on the strategy, OR a graceful-degradation `parse()`, OR `op.recover` — see "Strict-parser interaction" above |