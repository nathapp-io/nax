# Failure recovery: decoupling swap from prune (spec 2)

Date: 2026-09-07
Status: design, awaiting review
Repo: `nax` only — no nax-ai change, so no cross-repo landing gate
Related: #1883, #1884, #1892; follows #1913 (spec 1); baseline headroom #1914;
and closes #1900 as already-fixed. The binding lattice and peer map are **spec 3**.

## 1. Why

Spec 1 made one fact true end to end: *a rate limit happened, and the provider
said to wait N seconds*. It deliberately changed no policy. This spec changes
policy, and it changes it in one direction: **a transient failure should stop
costing an agent it did not need to cost.**

Three of the open failures are the same defect seen from three angles. A wall
clock timeout cannot try anyone else (#1883). A stalled provider stream cannot
retry itself (#1884). A 429 with nowhere to swap dies instantly, while the same
429 one branch away gets a full backoff (the exhaustion cliff). In each case the
machinery that would help exists and is one coupling away from being reachable.

The coupling is that `markUnavailable` means two different things at once.

## 2. Gaps

### Gap 1 — swap and prune are one action (#1883)

`manager.ts:398` marks the current agent unavailable *in order to* make
`nextCandidate` skip it, and `manager.ts:562` does the same on the complete
path. Pruning is therefore not a policy choice; it is the mechanism by which
hop selection works. You cannot swap without pruning.

`fail-timeout` is refused at `swap-decision.ts:63`, the first gate, for exactly
this reason — #1371 chose `category: "quality"` over `availability` in its own
words because *"the latter triggers `markUnavailable` and would prune the agent
for the whole run"*. That judgement is right and this spec does not dispute it.
It argues against pruning, not against trying someone else once.

The blast radius is narrower than #1371's commit message claims:
`resetTransientUnavailable()` (`unified-executor.ts:54,401`) already clears
everything except `fail-auth`/`fail-quota` at story boundaries. The real cost of
a wrong prune is the rest of the *story*.

### Gap 2 — `fail-service-down` has no same-agent lane (#1884)

`trySameAgentRetry` (`hop-retry-policy.ts:80-155`) branches on exactly three
outcomes: `fail-stale`, `fail-timeout`, `fail-adapter-error`. The other
same-agent site, `defaultRetryStrategy`, accepts only `fail-rate-limit` and
`fail-stale`. `fail-service-down` matches neither, so its `retriable: true` is a
field nothing reads, and the only recovery left is a swap that needs
`fallback.enabled` and a candidate. A pinned agent has neither.

This is a native-path gap specifically: after #1869 a stalled native stream
classifies `fail-service-down` (`native/errors.ts:30,38`), where it used to
classify as `fail-adapter-error` and *did* get three retries. The classification
got more accurate and the retry got lost. On the complete path the outcome
reaches both transports via `complete-exception-classifier.ts:75`.

### Gap 3 — the exhaustion cliff, on both paths

The rate-limit backoff lives *inside* the `!swapDecision.swap` branch
(`manager.ts:350-379`). So a 429 that `decideSwap` **accepts** and then finds no
candidate for falls to `onSwapExhausted` with no backoff at all — strictly worse
than the same failure being declined one branch away. At `hops: 0` it does not
even emit; it reports `"error"` silently.

`completeWithFallback` is worse still: it consults no retry strategy anywhere,
and emits `onSwapExhausted` **never** — not at `hops: 0`, not at `hops > 0`.

### Gap 4 — `category` has two values and both lies are load-bearing

`AdapterFailure.category` is `"availability" | "quality"`, and it is read as a
decision input at `swap-decision.ts:70`. Two entries in the table are therefore
written to steer behaviour rather than to describe the fault:

- `fail-timeout` files `quality` purely to dodge pruning (#1371, quoted above).
- a context overflow files `availability` though nothing is down.

Every new fault kind reopens the same argument, because the field being asked to
carry the decision has fewer values than the decision has cases.

### Gap 5 — a session failure can never escalate (#1892)

`decideStageAction` checks the human-review pause before it routes the failure
(`post-run.ts:298,505-531`), so `routeTddFailure`'s `session-failure` arm and
`resolveMaxAttemptsOutcome`'s `case "session-failure"` are both unreachable. Two
green tests assert `escalate` by calling `routeTddFailure` directly, bypassing
`decideStageAction`; one asserts `pause` through the reachable path. The suite
encodes both answers.

Observed: four stories hit one provider rate limit within 14 seconds. The two
routed `three-session-tdd` paused at attempt 1 with zero escalations; the one
routed `tdd-simple` escalated `balanced` → `powerful` and passed 49 minutes
later. Identical root cause, opposite outcomes, decided purely by test strategy.

## 3. Design

### 3.1 One outcome-keyed policy table is the SSOT

New pure module `src/agents/retry/failure-policy.ts`. Ten rows, one per
`AdapterFailure["outcome"]`, naming the four things a failure decides:

```ts
interface FailurePolicy {
  sameAgentRetry: "none" | "stale" | "timeout" | "adapter-error";
  swap: "never" | "immediate" | "after-retry-lane" | "quality-gated";
  cooldown: "none" | "run" | { ms: number };
  terminalBackoff: boolean;
}
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

Bold cells are the per-outcome delta. Everything else records today's behaviour
as data, with one change that cuts across the column: **every `{ms}` cooldown is
a change**, because today's `markUnavailable` has no expiry at all and is
cleared only at a story boundary. `quality-gated` preserves the existing
`fallback.onQualityFailure` gate exactly; `never` preserves `fail-aborted`'s
teardown guarantee.

`after-retry-lane` documents an invariant rather than adding a check.
`trySameAgentRetry` already runs before `decideSwap` and returns `null` once its
lane is spent, so by the time the swap decision sees a `fail-timeout` the lane is
spent by construction — and on the complete path, where no timeout lane exists,
it is trivially spent. Implementers should not add a second "is the lane done"
flag; the call order is the guarantee.

Four readers, no fifth: `decideSwap` reads `swap`, `trySameAgentRetry` reads
`sameAgentRetry`, the cooldown store reads `cooldown`, `resolveExhaustion` reads
`terminalBackoff`.

**Cooldown honours the provider.** When the failure carries
`retryAfterSeconds`, a `{ms}` cooldown uses it instead of the constant — so a
provider saying 300s parks that agent for 300s, not 60. This is spec 1's field
gaining its second consumer, on both transports: acpx populates it via
`parse-agent-error`, native via #1913.

**No new configuration.** The table is constants. Cooldown durations become
config only when a real run shows the default is wrong.

### 3.2 Three mechanisms replace one

**Cooldown store with expiry.** `markUnavailable(agent, failure)` records
`{failure, expiresAt}` from the table; `isUnavailable` consults an injectable
clock (`_agentManagerDeps`, so no test sleeps). `run` means no expiry.
`resetTransientUnavailable()`'s hardcoded `fail-auth`/`fail-quota` check
disappears into the table — its two `unified-executor.ts` callers become a
story-boundary sweep over expiries.

**Per-hop exclusion.** `nextCandidate(primary, hops, exclude)` takes the
just-failed agent explicitly. Hop selection stops depending on a state write,
which is the whole of Gap 1: `fail-timeout` can now swap with `cooldown: "none"`
and leave the agent selectable for the next story.

**One terminal routine.** New module `src/agents/retry/resolve-exhaustion.ts`.
All exits — swap declined, no candidate, hop cap reached — funnel through it.
Both `runWithFallback` and `completeWithFallback` use it, which is what gives the
complete path a backoff and an exhaustion signal it has never had.

**Backoff and the exhaustion event are separate concerns, and do not fire
together.** The backoff runs whenever the failure's policy sets
`terminalBackoff`, on every terminal exit, using the provider's own delay.
`onSwapExhausted` fires only when a swap was genuinely possible and had nowhere
to go — the swap was accepted and `nextCandidate` returned `null`, or the hop cap
was reached. A policy decline (`fallback-disabled`, `quality-failure-declined`,
`outcome-refused`, `no-failure`) is **not** exhaustion and must not emit: the
header of `swap-decline-log.test.ts` pins the decline log and `onSwapExhausted`
as distinct neighbouring signals, and collapsing them would displace one.

`onSwapExhausted` now also fires at `hops: 0`. That is deliberate: the event
comes to mean "nowhere left to go" rather than "nowhere left to go, having gone
somewhere first", and it is precisely spec 1's missing cliff-frequency
measurement.

### 3.3 `category` demoted to observability

No decision reads `category` after this spec. It survives as a derived tag on
`AgentFallbackRecord` and `StoryMetrics`, so `metrics/aggregator.ts:243` keeps
working untouched. With no behaviour resting on it, both lies lose their motive:
`fail-timeout` may describe itself honestly, because pruning is now a table
value of `none` rather than a consequence of the word `availability`.

**#1900 is already fixed in code.** Spec 1 (#1913) rewrote that header, and the
"does not govern a session turn" sentence no longer exists — the issue is merely
un-closed. Close it citing `c9d360ca7`; do not go hunting for the sentence. What
*is* still stale in that header is its claim that "the category split is
load-bearing: shouldSwap's fallback branch only accepts `availability`" — this
spec falsifies it, because `decideSwap` reads the policy table and never reads
`category`. Correct that sentence instead.

### 3.4 `session-failure` splits (#1892)

Pause-on-`session-failure` stays the ruling for a genuinely broken session. The
provider-availability case — rate limit, service down, quota — splits out and
escalates, which is what the observed run needed. `routeTddFailure`'s arm and
`resolveMaxAttemptsOutcome`'s case gain a real caller.

The two tests that assert `escalate` while bypassing `decideStageAction` are
rewired to go through it. A green test on an unreachable path enforces nothing.

### 3.5 Transport coverage

| concern | acpx | native |
| --- | --- | --- |
| `fail-timeout` swap (#1883) | yes — `turn-failure-classification.ts` (run), complete classifier | yes, same sources |
| `fail-service-down` lane (#1884) | complete path only — acpx's run path never emits it | run path (`native/errors.ts`) and complete path |
| exhaustion backoff | yes — `retryAfterSeconds` already populated by `parse-agent-error` | yes — populated since #1913 |
| cooldown expiry, per-hop exclusion | yes — manager-level, transport-agnostic | yes |
| #1892 split | yes — above both transports, touches no adapter |

The native turn-loop rate-limit wait added by spec 1 is unchanged and stays
native-only; acpx agents absorb that internally (the ACP-parity ruling).

## 4. Out of scope

- **The binding lattice and peer map** — spec 3, written against measurements.
- **The native turn-loop wait** — spec 1's, untouched.
- **Splitting `manager.ts` and `post-run.ts`** — #1914. This spec lands inside
  the temporary baseline headroom granted for it.
- **New configuration surface** — the table is constants.

## 5. Behaviour changes to expect

- A timed-out story now spends a hop it never spent before, bounded by
  `maxHopsPerStory`. This is a real cost change and the main thing to watch.
- An agent that fails transiently is selectable again after its cooldown, so
  later stories in the same run see a larger pool than they do today.
- `onSwapExhausted` fires in cases that previously emitted nothing, including on
  the complete path, which previously emitted nothing at all.
- A rate-limited story escalates instead of parking for a human.

## 6. Verification anchors

Behavioural runtime cases, not grep or file-content assertions.

| # | case | expects |
| --- | --- | --- |
| 1 | run path, `fail-timeout`, timeout lane spent, healthy fallback configured | swaps once (today: terminal) |
| 2 | after case 1, next story | the timed-out agent is selectable again — the #1371 regression guard |
| 3 | run path, `fail-aborted` | still never swaps |
| 4 | native run path, `fail-service-down` | adapter-error lane retries the same agent up to 3 times **before** any swap |
| 5 | case 4's lane spent, no candidate | backs off, then emits `onSwapExhausted` with `hops: 0` (today: instant death, no emit) |
| 6 | acpx run path, `fail-rate-limit` carrying `retryAfterSeconds: 45`, no candidate | backs off 45s — spec 1's behaviour, preserved through the new routine |
| 7 | complete path, `fail-rate-limit`, no candidate | backs off and emits `onSwapExhausted` (today: neither) |
| 8 | complete path, `fail-timeout` | swaps — no timeout lane exists there, so the lane is trivially spent |
| 9 | agent cooled down 60s, fake clock | excluded at t+30s, selectable at t+61s |
| 10 | `fail-auth`, story boundary sweep | still excluded — `run` has no expiry |
| 11 | `fail-timeout` swap with `cooldown: "none"` | the just-failed agent is still not selected for *this* hop |
| 12 | `session-failure` caused by a provider rate limit, through `decideStageAction` | escalates |
| 13 | a genuinely broken session, through `decideStageAction` | still pauses |
| 14 | any swap | `category` still present on the fallback record and `StoryMetrics` |
| 15 | a rate limit with `fallback.enabled` false | backs off, and emits **no** `onSwapExhausted` — a policy decline is not exhaustion |

Pairs that must both be non-empty: 1/2 (the swap and the guard that it did not
become a prune), 4/5, 12/13 (the split, and the ruling it preserves), 9/10
(expiry, and the exemption from it).

## 6a. Which existing tests this breaks

Checked against the tree at `c9d360ca7`. Only one file necessarily breaks:

- **`test/unit/agents/fail-timeout-should-swap.test.ts`** — all three tests assert
  `shouldSwap` returns `false` for `fail-timeout`, the third explicitly as an
  invariant overriding `onQualityFailure` because "the swap branch would call
  `markUnavailable` and prune the timed-out agent". It must be rewritten, not
  deleted: #1371's invariant (don't poison the pool) still holds and should be
  asserted **directly** — mark a timed-out agent and confirm it is not
  unavailable — rather than by the proxy of refusing the swap.

Three files that look like they should break, and do not — verified, so nobody
re-litigates them mid-implementation:

- `test/unit/agents/agent-manager-reset.test.ts` — asserts unavailability
  *immediately* after marking (no clock advance) and after
  `resetTransientUnavailable`. A cooldown preserves both.
- `test/unit/agents/manager.test.ts` — same immediacy, and its shared
  `availFailure` is `fail-auth`, whose cooldown is `"run"`, so its
  `nextCandidate` expectations are unaffected.
- `test/unit/agents/manager-swap-loop.test.ts` — asserts exactly one
  `onSwapExhausted` when both agents fail; still exactly one.

The two `#1892` tests that assert `escalate` by calling `routeTddFailure`
directly (`test/unit/execution/execution-stage.test.ts`,
`test/integration/pipeline/pipeline.test.ts`) keep passing either way — they
bypass `decideStageAction` and so pin a path that never runs. Rewire them
through `decideStageAction`; a green test on an unreachable path enforces
nothing.

## 7. Landing order

1. Baseline headroom for `manager.ts` and `post-run.ts` — **done**, #1914 tracks
   its removal.
2. `failure-policy.ts` plus its table tests. No caller yet.
3. Cooldown store and per-hop exclusion; both `markUnavailable` call sites.
4. `resolve-exhaustion.ts`, wired into both `runWithFallback` and
   `completeWithFallback`.
5. The `#1892` split, and the rewiring of its two bypassing tests.
6. `category` demotion, the `native/errors.ts` category sentence, and the
   `.nax/rules/retry-strategy.md` manager-tier claims (#1900 closed, not edited).
7. Full verification: `bun run test --force` (a cached green is not evidence),
   `typecheck`, `lint`.

## 8. What this unlocks for spec 3

Spec 3's binding lattice and peer map need three numbers that no artifact
carries today. This spec produces two of them as a side effect: the `hops: 0`
emission makes cliff frequency countable, and the cooldown store makes "how long
was an agent actually unavailable" observable rather than inferred. The third —
the `retryAfter` distribution — comes from spec 1 and still needs one real run
on the native profile.
