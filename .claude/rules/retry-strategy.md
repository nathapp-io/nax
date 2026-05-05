---
paths:
  - "src/agents/**/*.ts"
  - "src/operations/**/*.ts"
  - "src/routing/**/*.ts"
  - "src/pipeline/**/*.ts"
  - "src/execution/**/*.ts"
---

# Retry Strategy

> Introduced in issue #856. SSOT: `src/agents/retry/`.

All retry logic in nax is expressed through the `RetryStrategy` interface — no inline retry loops, no hardcoded delay constants, no `while (true)` with a counter elsewhere in the codebase.

## Two-tier model

| Tier | Site | Default | Override |
|:---|:---|:---|:---|
| **Manager** | `AgentManager.runWithFallback` (site #1) | `defaultRetryStrategy` — rate-limit only, 3 retries, 2s/4s/8s exponential | Pass `retryStrategy` to `AgentManager` constructor via `_agentManagerDeps` injection |
| **Op** | `callOp` complete-kind (site #2) | none — throws on first failure | Declare `retry` on `CompleteOperation` |

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

`callOp` is bounded by `MAX_COMPLETE_RETRY_ATTEMPTS = 20` regardless of the strategy. If that ceiling is hit, it throws `CALL_OP_MAX_RETRIES`.

## `RetryPreset` semantics

| Field | Meaning |
|:---|:---|
| `preset: "transient-network"` | Retry on any thrown `Error` or `AdapterFailure` where `af.retriable === true` |
| `maxAttempts` | Total call attempts including the first (2 = one retry, 3 = two retries) |
| `baseDelayMs` | Fixed wait between attempts (no backoff) |

`resolveRetryPreset` in `src/agents/retry/presets.ts` converts a `RetryPreset` to a live `RetryStrategy`.

## `defaultRetryStrategy` (manager tier)

Lives in `src/agents/retry/default-strategy.ts`. Fires **only** on `fail-rate-limit` outcome; all other failures pass through immediately. Backoff: `2^(attempt+1) * 1000` ms — 2s, 4s, 8s across 3 retries. Injected into `AgentManager` via the constructor; tests override via `_agentManagerDeps.sleep` + a custom strategy.

## What NOT to convert to RetryStrategy

`HopBody` callbacks on `RunOperation` are multi-turn session continuations, not single-call retries. Do not express them as `RetryStrategy`. They stay as `hopBody` on `RunOperation` (site outside callOp's retry path).

## `routing.llm.retries` / `retryDelayMs` — deprecation bridge

These config keys are deprecated (issue #856). They are still applied but warn at load time via `applyRoutingRetryDeprecationWarning` in `src/config/loader.ts`. The `classifyRouteOp` / `classifyRouteBatchOp` retry resolvers read them as a bridge until users migrate to op-level retry config. Do not add new readers of these keys.

## Abort-signal threading

`callOp`'s retry sleep is cancellable:

```typescript
await _callOpDeps.sleep(decision.delayMs, ctx.runtime.signal);
```

`_callOpDeps.sleep` uses `cancellableDelay` from `src/utils/bun-deps`. Always thread `ctx.runtime.signal` through; never call `Bun.sleep` directly inside a retry loop.

## Forbidden patterns

| ❌ Forbidden | ✅ Use Instead |
|:---|:---|
| Inline `while` / `for` retry loops with hardcoded counters | `retry` field on `CompleteOperation`, or `RetryStrategy` injected at construction |
| `while (true)` retry loops | `while (attempt <= MAX_COMPLETE_RETRY_ATTEMPTS)` — or better, declare `retry` on the op |
| Hardcoded `await Bun.sleep(2000)` between attempts | `_callOpDeps.sleep(decision.delayMs, signal)` (testable, cancellable) |
| New readers of `config.routing.llm?.retries` outside `classify-route.ts` | Op-level `retry` resolver reading from config slice |
| `MAX_RATE_LIMIT_RETRIES` constant (deleted) | `defaultRetryStrategy` / `RetryPreset.maxAttempts` |
