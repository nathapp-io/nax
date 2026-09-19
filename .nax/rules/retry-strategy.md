---
priority: 45
appliesTo:
  - "src/agents/**/*.ts"
  - "src/operations/**/*.ts"
  - "src/config/schemas-review.ts"
  - "src/session/session-keeper.ts"
stages:
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

> SSOT: `src/agents/retry/`. Introduced in #856.
> **How the sanctioned mechanisms work: `docs/guides/retry-strategy.md`** — declaring
> `retry` on an op, `RetryPreset` fields, `composeRetry`, `makeParseRetryStrategy`,
> `HopBody` composition, `exhaustedFallback`, `ParseValidationError` discrimination.

All retry logic in nax is expressed through the `RetryStrategy` interface — no inline retry
loops, no hardcoded delay constants, no `while (true)` with a counter elsewhere in the
codebase.

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
| **Manager** | `AgentManager.runWithFallback` (site #1) | `defaultRetryStrategy` — fires on every outcome `failurePolicyFor(outcome).terminalBackoff` marks (currently `fail-rate-limit`, `fail-stale`, `fail-service-down`), 3 retries, 2s/4s/8s exponential | Pass `retryStrategy` to `AgentManager` constructor via `_agentManagerDeps` injection |
| **Op** | `callOp` run-kind and complete-kind (site #2) | none — throws on first parse failure; complete-kind throws on first call failure | Declare `retry` on `RunOperation` or `CompleteOperation` |

**Op-tier strategies MUST NOT handle `fail-rate-limit`, `fail-stale` or
`fail-service-down`.** They are universal infrastructure concerns owned by
`defaultRetryStrategy` at the manager tier; handling them op-side causes double-retry (op
retries, then manager retries again) and confuses failure attribution. If an op-tier
strategy needs to handle rate-limits, that concern belongs in `defaultRetryStrategy`.

`callOp` is bounded by `MAX_COMPLETE_RETRY_ATTEMPTS = 20` regardless of the strategy.
Strategies that may keep retrying indefinitely must self-terminate via
`attempt >= maxAttempts`.

## Cooldown durations are availability expiries, not retry delays

The failure policy table (`src/agents/retry/failure-policy.ts`) carries cooldown
durations such as `TRANSIENT_COOLDOWN_MS` (60s for `fail-rate-limit`,
`fail-stale`, and `fail-service-down`). These are **availability expiries** — how
long an agent stays excluded from fallback candidacy after a failure — not retry
delays. Nothing sleeps on them: `resolveCooldownExpiry` turns one into an absolute
expiry recorded in `CooldownStore`, evaluated lazily on read, and a cooldown must
never be passed to `_agentManagerDeps.sleep` or `_callOpDeps.sleep`. They are
therefore not a `RetryStrategy` concern, and their presence in the policy table is
not a violation of the no-hardcoded-delays rule.

## Every op must have an exhaustion path

**Ops that cannot tolerate a raw `TurnResult` as their output MUST provide
`exhaustedFallback`.** When it is absent, `callOp` returns the last `TurnResult` as-is
(typed as `O`).

When an op's `parse()` throws on unparseable input, the op MUST use one of three
sanctioned escape hatches, or `ParseValidationError` propagates to the caller:

1. **`exhaustedFallback`** on the strategy — synchronous, receives `lastOutput`.
2. **Graceful-degradation `parse()`** — returns a `FAIL_OPEN`-style value instead of throwing.
3. **`op.recover`** — async, receives the full `input` and a `VerifyContext` (file I/O).

`callOp` tries them in that order, then falls back to a last-resort `TurnResult`
passthrough logged as **warn** — which indicates a missing escape hatch, not a healthy path.

## Abort-signal threading

Always thread `ctx.runtime.signal` through the retry sleep
(`_callOpDeps.sleep(decision.delayMs, ctx.runtime.signal)`); never call `Bun.sleep`
directly inside a retry loop.

## Forbidden patterns

| Forbidden | Use Instead |
|:---|:---|
| Inline `while` / `for` retry loops with hardcoded counters | `retry` field on `CompleteOperation`, or `RetryStrategy` injected at construction |
| `while (true)` retry loops | `while (attempt <= MAX_COMPLETE_RETRY_ATTEMPTS)` — or better, declare `retry` on the op |
| Hardcoded `await Bun.sleep(2000)` between attempts | `_callOpDeps.sleep(decision.delayMs, signal)` (testable, cancellable) |
| New readers of `config.routing.llm?.retries` / `retryDelayMs` outside `classify-route.ts` | Op-level `retry` resolver reading from config slice. Both keys are deprecated (#856) and warn at load time |
| `MAX_RATE_LIMIT_RETRIES` constant (deleted) | `defaultRetryStrategy` / `RetryPreset.maxAttempts` |
| Hand-rolled parse-retry loops inside an `op.hopBody` | `ctx.sendWithParseRetry` — declare `op.retry` and call `sendWithParseRetry` in the body; the loop is already there |
| Strategy `validate` and `op.parse` having different acceptance criteria | Define a shared validator helper (e.g. `validateLLMShape`) and call it from both |
| Run-kind op with strict (throwing) `parse()` and `op.retry` but no `exhaustedFallback` AND no `op.recover` that returns a non-null value | Provide `exhaustedFallback` on the strategy, OR a graceful-degradation `parse()`, OR `op.recover` — see *Every op must have an exhaustion path* |
