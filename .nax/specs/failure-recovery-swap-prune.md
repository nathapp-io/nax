# SPEC: Failure recovery — decouple swap from prune

<!-- spec-writing: completed-through-phase-6 -->

## Summary

A transient agent failure currently costs an agent it did not need to cost. `AgentManager.markUnavailable` means two things at once — "skip this agent for this hop selection" and "retire this agent" — so a wall-clock timeout cannot try a healthy agent without poisoning the pool, a stalled provider stream gets no same-agent retry, and a rate limit with no swap candidate dies with no backoff at all while the same failure one branch away gets a full one. This spec replaces that single overloaded mechanism with three separate ones: an outcome-keyed policy table as the single source of truth for what a failure decides, a cooldown store with an expiry, and one shared exhaustion routine used by both the run and complete paths.

## Motivation

Spec 1 (#1913) made one fact true end to end — *a rate limit happened, and the provider said to wait N seconds* — and deliberately changed no policy. This spec changes policy.

Three open issues are the same defect from three angles:

- **#1883** — after `fail-timeout`'s same-agent retry lane is spent, the op dies terminally without ever trying a healthy agent. `decideSwap` refuses at its first gate because swapping would call `markUnavailable` and prune the agent. #1371 chose `category: "quality"` for exactly this reason, in its own words: *"the latter triggers `markUnavailable` and would prune the agent for the whole run … a single slow story would poison the agent pool."* That judgement argues against **pruning**; it does not argue against **trying someone else once**. Today those two facts cannot be expressed separately, so the safe one forces the lossy one.
- **#1884** — `fail-service-down` is the one retriable availability outcome no same-agent path accepts. `trySameAgentRetry` branches on `fail-stale`, `fail-timeout` and `fail-adapter-error` only; `defaultRetryStrategy` accepts `fail-rate-limit` and `fail-stale` only. Its `retriable: true` is a field nothing reads. Before #1869 this fault classified as `fail-adapter-error` and got three retries; the classification got more accurate and the retry got lost.
- **The exhaustion cliff** — the rate-limit backoff lives *inside* the `!swapDecision.swap` branch, so a 429 that `decideSwap` accepts and then finds no candidate for reaches `onSwapExhausted` with no backoff. At `hops: 0` it emits nothing at all. `completeWithFallback` is worse: it consults no retry strategy anywhere and emits `onSwapExhausted` never, not even at `hops > 0`.

A fourth, **#1892**, is the same failure class arriving one layer up: `decideStageAction` computes `needsHumanReview = failureCategory === "session-failure"` and returns `pause` before `routeTddFailure` can escalate, so a provider rate limit parks a story for a human. In one observed run four stories hit the same rate limit within 14 seconds; the two routed `three-session-tdd` paused at attempt 1 with zero escalations, while the one routed `tdd-simple` escalated `balanced` → `powerful` and passed 49 minutes later. Identical root cause, opposite outcomes, decided purely by test strategy.

Underneath all four sits `AdapterFailure.category`, which has two values and is read as a decision input at `swap-decision.ts:70`. Two entries are therefore written to steer behaviour rather than describe the fault: `fail-timeout` files `quality` purely to dodge pruning, and a context overflow files `availability` though nothing is down.

## Design

The design intent, the full gap analysis and the rejected alternatives live in
`docs/superpowers/specs/2026-09-07-failure-recovery-swap-prune-design.md`. This section
records only what implementers must build against.

### Approach

One outcome-keyed policy table is the SSOT. `AdapterFailure.category` stops being read by any decision and survives as a derived observability tag, which is what removes the motive for both lies above.

`FailurePolicy` names the four things a failure decides:

```ts
export interface FailurePolicy {
  readonly sameAgentRetry: "none" | "stale" | "timeout" | "adapter-error";
  readonly swap: "never" | "immediate" | "after-retry-lane" | "quality-gated";
  readonly cooldown: "none" | "run" | { readonly ms: number };
  readonly terminalBackoff: boolean;
}

export function failurePolicyFor(outcome: AdapterFailure["outcome"]): FailurePolicy;
```

| outcome | sameAgentRetry | swap | cooldown | terminalBackoff |
| --- | --- | --- | --- | --- |
| `fail-auth` | none | immediate | run | false |
| `fail-quota` | none | immediate | run | false |
| `fail-rate-limit` | none | immediate | `{ms: 60_000}` | true |
| `fail-service-down` | **adapter-error** | immediate | **`{ms: 60_000}`** | **true** |
| `fail-stale` | stale | immediate | `{ms: 60_000}` | true |
| `fail-timeout` | timeout | **after-retry-lane** | **none** | false |
| `fail-adapter-error` | adapter-error | quality-gated | none | false |
| `fail-quality` | none | quality-gated | none | false |
| `fail-unknown` | none | quality-gated | none | false |
| `fail-aborted` | none | never | none | false |

Bold cells are the per-outcome delta. Every `{ms}` cooldown is also a change, because today's `markUnavailable` has no expiry at all. `quality-gated` preserves the existing `fallback.onQualityFailure` gate; `never` preserves `fail-aborted`'s teardown guarantee.

`after-retry-lane` documents an invariant rather than adding a check: `trySameAgentRetry` already runs before `decideSwap` and returns `null` once its lane is spent, so by the time the swap decision sees a `fail-timeout` the lane is spent by construction, and on the complete path — where no timeout lane exists — it is trivially spent. Do not add a second "is the lane done" flag; the call order is the guarantee.

A `{ms}` cooldown uses `failure.retryAfterSeconds` when the failure carries it, so a provider asking for 300s parks that agent for 300s rather than 60. This is spec 1's field gaining its second consumer, on both transports: acpx populates it via `parse-agent-error`, native since #1913.

**Cooldown durations are not retry delays.** `.nax/rules/retry-strategy.md` forbids hardcoded delay constants because retry timing must be expressed through `RetryStrategy`. A cooldown is an *availability expiry*, not a wait before a re-dispatch: nothing sleeps on it. The table constants are therefore not a violation of that rule, and no cooldown value may be passed to `_agentManagerDeps.sleep`.

**Backoff and the exhaustion event are separate concerns.** `resolveExhaustion` owns both, but they do not fire together. The backoff runs whenever the failure's policy sets `terminalBackoff`, on every terminal exit. `onSwapExhausted` fires only when a swap was genuinely possible and had nowhere to go — the swap was accepted and `nextCandidate` returned `null`, or the hop cap was reached. A policy decline (`fallback-disabled`, `quality-failure-declined`, `outcome-refused`, `no-failure`) is not exhaustion and must not emit, which keeps the decline log and `onSwapExhausted` the distinct neighbouring signals `swap-decline-log.test.ts` pins them as.

**No new configuration.** The table is constants. Cooldown durations become config only when a real run shows the default is wrong.

### Integration

Read-only symbols, verified at their current shape:

- `decideSwap(failure: AdapterFailure | undefined, hopsSoFar: number, fallback: SwapFallbackConfig | undefined): SwapDecision` — `src/agents/swap-decision.ts:57`. Gate order is load-bearing and documented in that file.
- `availableCandidates(map, agent, isExcluded: (candidate: string) => boolean): FallbackTarget[]` — `src/agents/swap-decision.ts:98`. The shared filter behind `resolveFallbackChain` and `nextCandidate`.
- `_agentManagerDeps` — `src/agents/manager.ts:70`. Currently carries only `sleep`; this is the injection seam tests already use.
- `RetryStrategy.shouldRetry(failure, attempt, ctx): RetryDecision` — `src/agents/retry/types.ts`. The manager tier's single retry seam.
- `PostRunInspectionResult` — `src/execution/post-run.ts:56`, with `failureCategory` and `needsHumanReview`.
- `post-run.ts:146` sets `rateLimited: lastFailure?.outcome === "fail-rate-limit"` — spec 1's #1897 fix, and the seam US-005 extends.

Mutated symbols. The baseline exists only to locate the code; the target is the interface to implement.

**`AgentManager.markUnavailable`** — `src/agents/manager.ts:157`
- Baseline: `markUnavailable(agent: string, reason: AdapterFailure): void`, writing `this._unavailable: Map<string, AdapterFailure>` with no expiry.
- Target: same signature, delegating to a cooldown store that records an expiry resolved from `failurePolicyFor(reason.outcome)` and `reason.retryAfterSeconds`. `isUnavailable(agent: string): boolean` consults an injected clock.

**`AgentManager.nextCandidate`** — `src/agents/manager.ts:203`
- Baseline: `nextCandidate(current: string, _hopsSoFar: number): FallbackTarget | null`.
- Target: `nextCandidate(current: string, hopsSoFar: number, exclude?: string): FallbackTarget | null`, where `exclude` names the just-failed agent for this selection only and is filtered alongside `_isExcluded`.

**`AgentManager.resetTransientUnavailable`** — `src/agents/manager.ts:167`
- Baseline: iterates `_unavailable` and deletes every entry whose `outcome` is not `fail-auth` or `fail-quota`.
- Target: sweeps expired cooldowns and clears every entry whose policy cooldown is not `"run"`. The hardcoded outcome pair is replaced by the table; the two call sites at `src/execution/unified-executor.ts:54,401` are unchanged.

**`decideSwap`** — `src/agents/swap-decision.ts:57`
- Baseline: refuses `fail-timeout` at the outcome gate; accepts when `failure.category === "availability"`; otherwise consults `fallback.onQualityFailure`.
- Target: reads `failurePolicyFor(failure.outcome).swap`. `never` refuses with `outcome-refused`; `immediate` and `after-retry-lane` accept; `quality-gated` consults `fallback.onQualityFailure` as today. `failure.category` is not read.

**`trySameAgentRetry`** — `src/agents/retry/hop-retry-policy.ts:80`
- Baseline: branches on `fail-stale`, `fail-timeout`, `fail-adapter-error` by literal outcome comparison.
- Target: admits a failure to a lane when `failurePolicyFor(outcome).sameAgentRetry` names it, so `fail-service-down` enters the `adapter-error` lane under `execution.sessionErrorRetryableMaxRetries`. Per-lane caps and returned shapes are unchanged.

**`defaultRetryStrategy.shouldRetry`** — `src/agents/retry/default-strategy.ts:22`
- Baseline: returns `{retry: false}` unless the outcome is `fail-rate-limit` or `fail-stale`.
- Target: retries when `failurePolicyFor(outcome).terminalBackoff` is true, which adds `fail-service-down`. The `MAX_RETRIES` cap and the `retryAfterSeconds`-beats-computed-backoff rule from spec 1 are unchanged.

**`decideStageAction` / post-run inspection** — `src/execution/post-run.ts:332`, `:298`
- Baseline: `needsHumanReview = failureCategory === "session-failure"`, and `decideStageAction` returns `{action: "pause"}` for it before reaching `routeTddFailure`.
- Target: a session failure whose underlying adapter failure is a provider-availability outcome (`fail-rate-limit`, `fail-quota`, `fail-service-down`) reaches `routeTddFailure` and escalates; every other session failure still pauses with the unchanged reason string.

### Failure Handling

| condition | behaviour |
| --- | --- |
| `failurePolicyFor` receives an outcome with no table row | not reachable — the table is exhaustive over the `outcome` union and the compiler enforces it via a `Record<AdapterFailure["outcome"], FailurePolicy>` type. No runtime default. |
| A failure carries `retryAfterSeconds` that is negative, `NaN` or infinite | the table constant is used instead. Mirrors spec 1's guard in `defaultRetryStrategy`. |
| `resolveExhaustion` is reached with no `AdapterFailure` | returns without backing off and without emitting `onSwapExhausted` — there is no failure to consult a strategy about, and no swap was possible. |
| The abort signal fires during an exhaustion backoff | the sleep is cancellable and the routine returns `cancelled` without emitting `onSwapExhausted`, preserving today's shutdown behaviour at `manager.ts:360`. |
| A cooldown entry's expiry has passed | the agent is selectable again; expiry is evaluated on read, so no sweep is required for correctness. |

## Out of Scope

- The binding lattice and the peer map for `(agent, tier)` slots are deferred to spec 3, which is written against measurements this spec and spec 1 make available.
- Native agent swap remains structurally impossible and is not addressed: `NATIVE_AGENT` is the only native agent name and `agent.protocol: "native"` requires `agent.default: "native"`.
- The native turn-loop rate-limit wait added by spec 1 in `src/agents/native/session/turn-retry.ts` is unchanged; acpx agents absorb the same concern internally, which is ACP parity and not a third retry tier.
- Splitting `src/agents/manager.ts` and `src/execution/post-run.ts` is deferred to #1914; this spec lands inside the temporary file-size baseline headroom granted for it.
- No new configuration keys are introduced; cooldown durations stay constants in the policy table.
- Thread-safety and monotonic-clock behaviour of the cooldown store are out of scope: nax dispatch is single-threaded per manager instance and cooldowns are advisory, so a wall-clock jump costs at most one extra or one skipped hop.
- Cross-run persistence of cooldowns is out of scope; the store lives on the `AgentManager` instance and is cleared by `reset()`.
- US-005 only: how many attempts an escalating session failure gets before it finally pauses is out of scope — escalation reuses the existing attempt ladder unchanged.
- US-004 only: de-duplicating `onSwapExhausted` when one story exhausts on both the run and the complete path is out of scope — the two are separate operations and each reports its own outcome.

## Stories

Six stories. US-001 is a leaf the next three consume; US-005 is independent of the manager work and can land in any order; US-006 is terminal and must land last because it documents behaviour the earlier stories create.

### US-001 — Failure policy table

The outcome-keyed SSOT, with no caller yet.

- **Creates:** `src/agents/retry/failure-policy.ts`, `test/unit/agents/retry/failure-policy.test.ts`
- **Context Files:** `src/context/engine/types.ts`, `src/agents/swap-decision.ts`, `src/agents/retry/hop-retry-policy.ts`, `src/agents/retry/default-strategy.ts`
- **Depends on:** nothing

### US-002 — Cooldown with expiry, and per-hop exclusion

Splits `markUnavailable`'s two meanings. Depends on US-001 for the cooldown durations.

- **Creates:** `src/agents/cooldown-store.ts`, `test/unit/agents/cooldown-store.test.ts`
- **Context Files:** `src/agents/manager.ts`, `src/agents/swap-decision.ts`, `src/agents/manager-types.ts`, `src/execution/unified-executor.ts`, `src/agents/retry/failure-policy.ts` — created by US-001, consumed here
- **Depends on:** US-001

### US-003 — A timeout swaps without pruning, and a stalled stream retries

The two behavioural issues, both now expressible. Depends on US-001 (the table) and US-002 (the cooldown that makes a non-pruning swap safe).

- **Context Files:** `src/agents/swap-decision.ts`, `src/agents/retry/hop-retry-policy.ts`, `src/agents/retry/failure-policy.ts`, `src/agents/native/errors.ts`
- **Depends on:** US-001, US-002

### US-004 — One exhaustion routine, both paths

- **Creates:** `src/agents/retry/resolve-exhaustion.ts`, `test/unit/agents/retry/resolve-exhaustion.test.ts`
- **Context Files:** `src/agents/manager.ts`, `src/agents/retry/default-strategy.ts`, `src/agents/retry/types.ts`, `src/agents/retry/failure-policy.ts`
- **Depends on:** US-001, US-002, US-003

### US-005 — A rate-limited story escalates instead of parking

Independent of the manager work; touches only the execution layer.

- **Context Files:** `src/execution/post-run.ts`, `src/pipeline/stages/execution-helpers.ts`, `src/execution/escalation/tier-escalation.ts`
- **Depends on:** nothing

### US-006 — Terminal cleanup: rules SSOT and the stale header

Deletion and documentation only, no new behaviour. Must land last.

- **Context Files:** `.nax/rules/retry-strategy.md`, `src/agents/native/errors.ts`, `src/agents/retry/default-strategy.ts`
- **Depends on:** US-003, US-004
- **Verification:** removals and rule-drift are verified by the build/static gate, not by acceptance criteria — `bun run check:rules-drift` and `bun run typecheck`.

### Modifies

**US-003**
- `test/unit/agents/fail-timeout-should-swap.test.ts` — all three tests assert `shouldSwap` returns `false` for `fail-timeout`, the third explicitly as an invariant that overrides `onQualityFailure` because "the swap branch would call `markUnavailable` and prune the timed-out agent". The replacement invariant preserves the intent and inverts the mechanism: `fail-timeout` swaps once its retry lane is spent, and its policy cooldown of `"none"` means the agent is never pruned, so the pool is not poisoned.

**US-005**
- `test/unit/execution/execution-stage.test.ts` — asserts `escalate` by calling `routeTddFailure` directly, bypassing `decideStageAction`, so it pins a path that never runs. The replacement invariant is the same expectation driven through `decideStageAction` with a provider-availability session failure.
- `test/integration/pipeline/pipeline.test.ts` — asserts `escalate` by calling `routeTddFailure` directly for both lite and non-lite modes, with the same bypass. The replacement invariant is the same expectations driven through `decideStageAction`.

Deliberately **not** listed: `test/unit/agents/agent-manager-reset.test.ts`, `test/unit/agents/manager.test.ts` and `test/unit/agents/manager-swap-loop.test.ts` were each checked and survive unchanged. They assert behaviour the design preserves — an agent is unavailable immediately after being marked (no clock advance), `resetTransientUnavailable` clears a `fail-rate-limit` and retains `fail-auth`, and one exhaustion event fires when both agents fail. `manager.test.ts`'s shared `availFailure` is `fail-auth`, whose policy cooldown is `"run"`, so its `nextCandidate` expectations are unaffected.

### Seams

- **US-001 → US-002/US-003/US-004.** `failurePolicyFor` is the new externally-visible symbol. Each consumer story declares a seam AC that stubs it and proves the consumer reads the table rather than hardcoding the outcome, by observing the consumer's behaviour change when the stubbed row changes.
- **US-004 → `AgentManager`.** `resolveExhaustion` is called from both `runWithFallback` and `completeWithFallback`; both entry points carry their own seam AC.
- **US-002 → US-003.** A non-pruning swap is only safe because the cooldown store exists; US-003's AC that the timed-out agent remains selectable is the invariant that binds them.

## Acceptance Criteria

### US-001 — Failure policy table

1. `[unit]` `failurePolicyFor` is importable from `src/agents/retry/failure-policy.ts` and returns a `FailurePolicy` whose four fields are populated for every one of the ten `AdapterFailure` outcomes.
2. `[unit]` calling `failurePolicyFor` with `"fail-timeout"` returns `swap` equal to `"after-retry-lane"` and `cooldown` equal to `"none"`.
3. `[unit]` calling `failurePolicyFor` with `"fail-service-down"` returns `sameAgentRetry` equal to `"adapter-error"` and `terminalBackoff` equal to `true`.
4. `[unit]` calling `failurePolicyFor` with `"fail-auth"` and with `"fail-quota"` returns `cooldown` equal to `"run"` for both.
5. `[unit]` calling `failurePolicyFor` with `"fail-aborted"` returns `swap` equal to `"never"`.
6. `[unit]` calling `failurePolicyFor` with `"fail-quality"` and with `"fail-unknown"` returns `swap` equal to `"quality-gated"` for both.
7. `[unit]` calling `failurePolicyFor` with `"fail-rate-limit"` returns a `cooldown` object whose `ms` is a finite number greater than zero.

### US-002 — Cooldown with expiry, and per-hop exclusion

1. `[unit]` an agent marked unavailable with a `fail-rate-limit` failure is reported unavailable by `isUnavailable` while the injected clock is before the cooldown's expiry, and available once the injected clock is advanced past it.
2. `[unit]` an agent marked unavailable with a `fail-auth` failure is still reported unavailable after the injected clock is advanced by an hour, because its policy cooldown is `"run"`.
3. `[unit]` an agent marked unavailable with a `fail-rate-limit` failure carrying `retryAfterSeconds` of 300 is still unavailable at 120 seconds of injected clock advance and available at 301, showing the provider's own delay overrides the table constant.
4. `[unit]` an agent marked unavailable with a failure whose `retryAfterSeconds` is negative is unavailable for the table constant's duration, not a negative or immediate one.
5. `[unit]` an agent marked unavailable with a `fail-timeout` failure is reported available immediately, because its policy cooldown is `"none"`.
6. `[unit]` calling `nextCandidate` with an `exclude` argument naming an otherwise-available agent returns a different candidate, and returns `null` when that agent was the only one.
7. `[unit]` calling `nextCandidate` without an `exclude` argument returns the same candidate it returns today for an unchanged fallback map, so existing callers are unaffected.
8. `[unit]` `resetTransientUnavailable` clears an agent cooled down for a `fail-rate-limit` failure and retains one cooled down for `fail-auth`.
9. `[unit]` **Seam.** With `failurePolicyFor` stubbed to return `cooldown: "run"` for `"fail-rate-limit"`, an agent marked unavailable with that outcome is still unavailable after the injected clock is advanced by an hour — proving the cooldown duration is read from the table rather than hardcoded.
10. `[unit]` marking an agent unavailable emits `onAgentUnavailable` with the agent name and the failure, unchanged from today.

**Out of scope:** concurrent mutation of the cooldown store from parallel dispatch (nax dispatch is single-threaded per manager instance); monotonic-clock guarantees under wall-clock adjustment (a jump costs at most one extra or one skipped hop); persistence of cooldowns across runs.

### US-003 — A timeout swaps without pruning, and a stalled stream retries

1. `[unit]` `decideSwap` called with a `fail-timeout` failure, fallback enabled and `onQualityFailure` unset returns `{swap: true}`.
2. `[unit]` `decideSwap` called with a `fail-aborted` failure returns `{swap: false, reason: "outcome-refused"}`, unchanged.
3. `[unit]` `decideSwap` called with a `fail-quality` failure returns `{swap: false, reason: "quality-failure-declined"}` when `onQualityFailure` is unset and `{swap: true}` when it is enabled, unchanged.
4. `[unit]` `decideSwap` called with a `fail-rate-limit` failure whose `category` field is set to `"quality"` still returns `{swap: true}`, proving the decision no longer reads `category`.
5. `[integration]` after `runWithFallback` swaps away from an agent on a `fail-timeout`, that agent is reported available by `isUnavailable` — the #1371 invariant, preserved by cooldown rather than by refusing the swap.
6. `[integration]` after `runWithFallback` swaps away from an agent on a `fail-auth`, that agent is reported unavailable.
7. `[unit]` `trySameAgentRetry` called with a `fail-service-down` failure and an attempt count below `execution.sessionErrorRetryableMaxRetries` returns a same-agent retry decision rather than `null`.
8. `[unit]` `trySameAgentRetry` called with a `fail-service-down` failure whose attempts have reached `sessionErrorRetryableMaxRetries` returns `null`, so the swap path is reached rather than retrying forever.
9. `[unit]` `trySameAgentRetry` called with a `fail-stale` failure returns a stale-lane decision with its existing cap, unchanged.
10. `[unit]` **Seam.** With `failurePolicyFor` stubbed to return `swap: "never"` for `"fail-rate-limit"`, `decideSwap` called with that outcome returns `{swap: false}` — proving `decideSwap` consults the table.
11. `[unit]` **Seam.** With `failurePolicyFor` stubbed to return `sameAgentRetry: "none"` for `"fail-service-down"`, `trySameAgentRetry` returns `null` for that outcome — proving lane admission is read from the table.

### US-004 — One exhaustion routine, both paths

1. `[unit]` `resolveExhaustion` is importable from `src/agents/retry/resolve-exhaustion.ts` and, given a failure whose policy sets `terminalBackoff` true and a retry strategy that grants a retry, reports that the caller should retry and calls the injected sleep once with the granted delay. Every timing AC below asserts the delay handed to the injected sleep; no test waits in real time.
2. `[unit]` `resolveExhaustion` given a failure whose policy sets `terminalBackoff` false does not consult the retry strategy and reports exhaustion immediately.
3. `[unit]` `resolveExhaustion` given no failure reports exhaustion without consulting the retry strategy and without emitting `onSwapExhausted`.
4. `[unit]` `resolveExhaustion` with an already-aborted signal reports cancellation and does not emit `onSwapExhausted`.
5. `[integration]` a `fail-rate-limit` on the run path with fallback enabled and no available candidate calls the injected sleep with the provider's `retryAfterSeconds` expressed in milliseconds, and then emits `onSwapExhausted` carrying `hops: 0`.
6. `[integration]` a `fail-rate-limit` on the run path with `agent.fallback.enabled` false calls the injected sleep with the same duration as case 5 — the backoff no longer depends on which gate refused — and emits no `onSwapExhausted`, because a policy decline is not exhaustion.
7. `[integration]` an acpx `fail-rate-limit` carrying `retryAfterSeconds` of 45 with no candidate calls the injected sleep with 45000 rather than the computed 2000, preserving spec 1's behaviour through the new routine.
8. `[integration]` a `fail-rate-limit` on the **complete** path with no candidate calls the injected sleep and then emits `onSwapExhausted`, where today it does neither.
9. `[integration]` a `fail-timeout` on the complete path swaps to an available candidate, because no timeout lane exists there and the lane is therefore spent.
10. `[integration]` an exhaustion that follows one or more successful hops emits `onSwapExhausted` with the hop count reached, unchanged from today.
11. `[integration]` a `fail-quality` failure with `onQualityFailure` unset emits no `onSwapExhausted` and performs no backoff, because its policy declines the swap and sets `terminalBackoff` false.
12. `[unit]` **Seam.** With `resolveExhaustion` stubbed, invoking `AgentManager.runWithFallback` with a failure and no swap candidate calls it once with that failure.
13. `[unit]` **Seam.** With `resolveExhaustion` stubbed, invoking `AgentManager.completeWithFallback` with a failure and no swap candidate calls it once with that failure.

**Out of scope:** deduplicating `onSwapExhausted` when a single story exhausts on both the run and complete paths — the two are separate operations and each reports its own outcome.

### US-005 — A rate-limited story escalates instead of parking

1. `[unit]` `decideStageAction` given a `session-failure` whose underlying adapter failure outcome is `fail-rate-limit` returns an action of `"escalate"`.
2. `[unit]` `decideStageAction` given a `session-failure` whose underlying adapter failure outcome is `fail-quota` returns an action of `"escalate"`.
3. `[unit]` `decideStageAction` given a `session-failure` whose underlying adapter failure outcome is `fail-service-down` returns an action of `"escalate"`.
4. `[unit]` `decideStageAction` given a `session-failure` with no provider-availability outcome returns `{action: "pause", reason: "Human review needed: session-failure"}`, preserving the 2026-05 ruling and its exact reason string.
5. `[unit]` the post-run inspection reports a provider-availability flag that is true for `fail-rate-limit`, `fail-quota` and `fail-service-down`, and false for `fail-quality` and `fail-unknown`.
6. `[unit]` `decideStageAction` given a `tests-failing` category returns the action it returns today, unchanged.
7. `[integration]` a story whose agent session fails to a provider rate limit reaches `routeTddFailure` and escalates its model tier, rather than pausing at attempt 1.
8. `[unit]` `resolveMaxAttemptsOutcome` called with `"session-failure"` returns `"fail"`, now reachable because attempts can be exhausted.

**Out of scope:** changing how many attempts an escalating session failure gets before it pauses — the existing attempt ladder is unchanged; escalation reuses it.

### US-006 — Terminal cleanup: rules SSOT and the stale header

Deletion and documentation only. Verified by the build/static gate — `bun run check:rules-drift` and `bun run typecheck` — not by acceptance criteria, per the guide's removal rule.

- `.nax/rules/retry-strategy.md` is the canonical store and is updated to state the manager tier's real accepted outcomes (`fail-rate-limit`, `fail-stale` and `fail-service-down`), so its "op-tier strategies MUST NOT handle these" prohibition covers the outcome US-003 promoted. It currently documents `defaultRetryStrategy` as firing only on `fail-rate-limit`, which was already stale before this spec.
- The Claude-side mirror under `.claude/rules/` is regenerated from the canonical store rather than hand-edited.
- The header comment at `src/agents/native/errors.ts:10`, which claims the failure table "does not govern a session turn", is corrected — it has been stale since #1840 and misdirected a live diagnosis (#1900).
- Any commentary in `src/agents/retry/default-strategy.ts` naming the accepted outcomes is brought in line with the table.
