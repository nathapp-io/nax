# Native failure classification and rate-limit wait (spec 1)

Date: 2026-09-07
Status: design, awaiting review
Repos: `nax-ai` (first), then `nax`
Related: #1893 (re-scoped), #1897; sets up spec 2 (#1883, #1884, #1892)

## 1. Why

A rate limit on the native transport is currently answered by machinery that
either cannot see it or cannot act on it. The provider supplies its own
recovery time on every 429; nax never uses it, and on one path nax-ai retries
the 429 as if it were a connection reset.

This spec makes one fact — *a rate limit happened, and the provider said to
wait N seconds* — true end to end, and makes the cheapest layer that can act
on it do so. It deliberately does **not** redesign swap or escalation policy;
that is spec 2.

### The premise that did not survive review

The obvious diagnosis — "native session-turn failures lose their
classification" — is false. nax#1838 and nax#1840 already fixed it:
`native/adapter.ts:381` classifies through `toAdapterFailure`, `SessionTurnError`
carries the `adapterFailure`, and `build-hop-callback.ts:470` reads it. The
comment at `native/errors.ts:10` saying *"this table does not govern a session
turn"* is **stale** and predates both PRs. #1893's stated premise rests on that
comment and does not hold.

What is actually broken is narrower and is listed below.

## 2. Gaps

### Gap 0 — `classifyThrown` presumes transport (nax-ai)

`src/protocols/errors.ts:150` returns `kind: "transport"` for **any** thrown
value. Its doc comment justifies this as "a throw with no HTTP response", but
nothing verifies the throw lacks one, and provider SDKs routinely throw an
error object carrying a status.

Consequence: a 429 that surfaces as a throw is filed as a transport fault, is
retried by `retryTransportFaults` at 250ms then 500ms (`retry.ts:29`,
`retries: 2` default per `client.ts:24`), and loses its `retryAfter` entirely —
`classifyThrown` builds a `ProtocolError` with no status and no `retryAfter`.
This directly violates nax-ai's own §10.1 policy that rate limits "must never
be retried internally".

It also explains #1893's evidence: six consecutive 429s (two calls x three
attempts) roughly 200ms apart, with **zero** `agent-manager` log entries even
though `agent.fallback.enabled` defaulted to `false` and a decline would
otherwise have logged. The failures never reached nax.

The event path is correct and is not in scope: a 429 *with* a response arrives
as pi-ai's `error` event, `classifyProviderError(429, ...)` returns
`"rate-limit"`, `parseRetryAfter(observed?.headers)` attaches `retryAfter`
(`pi-client.ts:339-355`), and `isRetryableErrorEvent` — which accepts only
`"transport"` — correctly declines to retry it.

### Gap 1 — `retryAfterSeconds` is never populated on native (nax)

`toAdapterFailure(kind: string)` (`native/errors.ts:79`) is a lookup into a
frozen table keyed by kind alone. It has no parameter through which a
`retryAfter` could arrive, so `AdapterFailure.retryAfterSeconds` is `undefined`
for every native failure — even though both call sites (`adapter.ts:216`,
`adapter.ts:381`) hold the whole `err.protocolError`, which carries it, and
`turn-retry.ts:105` already reads that same field one module away.

The acpx path populates it correctly (`acp/adapter.ts:272`,
`complete-exception-classifier.ts:53`). This is a native-only hole in a field
that already exists.

### Gap 2 — nothing reads `retryAfterSeconds` (nax)

Grepping `src/` for `retryAfterSeconds` returns producers only — the acpx
parser, the acpx adapter, the complete-exception classifier — plus an unrelated
webhook rate limiter. **There are zero consumers on any retry path.**
`defaultRetryStrategy` computes `2 ** (attempt + 1) * 1000` and ignores the
provider's own number even in the acpx case where it is correctly populated.

The field is write-only across both transports.

### Gap 3 — `fail-rate-limit` has no arm in the tiers that run first (nax)

Four tiers exist. Ordering defeats all of them:

| tier | handles rate limit? | why it does not fire |
| --- | --- | --- |
| 0. nax-ai `retryTransportFaults` | no, by policy | but gap 0 makes it fire anyway, wrongly |
| 1. `turn-retry.ts` | no | `RETRYABLE_KINDS = {transport, overloaded}`; defers to the manager by comment |
| 2. `trySameAgentRetry` | no | branches on `fail-stale`, `fail-timeout`, `fail-adapter-error` only |
| 3. `defaultRetryStrategy` | **yes** | but it sits inside `if (!swapDecision.swap)` (`manager.ts:331-373`), reachable only when a swap was refused |

Tier 1 defers to a receiver that, on native, is behind a gate that does not
refuse: `decideSwap` accepts on `category: "availability"`, so control leaves
the branch containing the backoff before reaching it.

### Gap 4 — the outcome is not reported (nax, #1897)

`applyPostRunInspection` rebuilds `ctx.agentResult` from the plan's phase
outputs with `rateLimited: false` hardcoded (`post-run.ts:141-150`), discarding
the value `build-hop-callback.ts:481` set correctly. Every story that died to a
429 therefore reports `"rateLimited": false` in its `Agent session failed` log
line, and the two downstream consumers (`post-run.ts:572-583`) are unreachable.

Without this, the telemetry justification for landing spec 1 before spec 2 is
hollow — the artifacts would still not show which failures were rate limits.

## 3. Design

### 3.1 The fact

No new type. `AdapterFailure.retryAfterSeconds` already exists
(`context/engine/types.ts:58`); this spec makes it true. Two signature changes.

**nax-ai — `classifyThrown` stops presuming.** Read a status off the thrown
value (`status`, `statusCode`, or `response.status`). When a finite status is
present, defer to the existing `classifyProviderError(status, message)` and
pull `retryAfter` from the throw's headers using the existing `parseRetryAfter`.
**Absent a status, return `transport` exactly as today.**

This is a widening, not a reinterpretation: the connection-reset case the
function was written for is untouched, and an unrecognised throw shape stays
transport. Abort is already rethrown in the same catch, ahead of this call,
so abort-as-abort is preserved.

**nax — `toAdapterFailure` takes the error, not the kind.** The signature
becomes `toAdapterFailure(protocolError)`: `.kind` drives the same frozen table
lookup, `.retryAfter` populates `retryAfterSeconds`. Two call sites
(`adapter.ts:216`, `adapter.ts:381`). The table stays kind-keyed and the
"maps from a discriminated kind and never a message" rule at
`native/errors.ts:5` is untouched — only the carrier widens.

Delete the stale note at `native/errors.ts:10` in the same change.

### 3.2 Where the wait goes

**The turn loop, not the manager.** `turn-retry.ts`'s own header already makes
the argument: on a throw from `deps.complete`, `messages` is unchanged and no
tool from that round trip has executed, so a re-issue costs **one round trip**.
Waiting at the manager instead costs a whole hop and a fresh session. The
manager's handler is also unreachable on native (gap 3).

The machinery is already written. `turnRetryDelayMs` (`turn-retry.ts:104`)
already prefers `retryAfter` over computed backoff and already caps by
`remainingMs`. Rate limit is merely excluded from the kind set. So:

1. Add `"rate-limit"` to `RETRYABLE_KINDS`. Delete the deferral comment naming
   a receiver that does not run.
2. **Fail fast rather than sleeping the cap.** Today `Math.min(delayMs,
   remainingMs)` means a provider advertising 300s against 30s of remaining
   budget sleeps 30s, re-issues, and aborts immediately — 30s spent to learn
   nothing. When `retryAfter` exceeds the remaining budget, do not retry at
   all; surface the failure so the layer above can act on it while budget
   remains.

   When `remainingMs` is absent the turn is unbounded (`TurnDeadline`'s
   `UNBOUNDED`), so nothing caps the wait and the fail-fast rule does not
   apply — wait the advertised `retryAfter` and re-issue.

This is the only place in spec 1 that adds logic rather than plumbing.

`"context-overflow"` keeps its dedicated compaction path in `turn-loop.ts` and
must still never be handled here. `"auth"` and `"bad-request"` stay terminal.

**Second consumer, one line.** `defaultRetryStrategy` prefers
`failure.retryAfterSeconds * 1000` when present, falling back to
`2 ** (attempt + 1) * 1000`. This fixes **acpx** as well, where the field is
already populated correctly and thrown away today.

### 3.3 Reporting (#1897)

Carry the hop's `AdapterFailure.outcome` to `applyPostRunInspection` and derive
`rateLimited` from it (`outcome === "fail-rate-limit"`) rather than threading
the boolean. The outcome is strictly more informative and keeps one source of
truth; the boolean stays for the existing consumers. The `Agent session failed`
log line and the escalation reason then tell the truth.

**Not through the plan result.** `.claude/rules/adapter-wiring.md` Rule 6
forbids routing result-side data back through `CallContext`, and nax#1707
already settled the shape for exactly this problem: a **run-scoped sink on
`ctx.runtime`, written at the `callOp` seam**. `recordAgentFallbacks`
(`call-resolvers.ts:140`, called from `call.ts:462`) is the precedent, and the
comment above that call already names this defect — *"post-run.ts rebuilds
ctx.agentResult from the implementer's phase output, so anything left on the
AgentResult here is dropped before metrics run."*

So: add `runtime.lastAdapterFailure: Map<string, AdapterFailure>` alongside
`runtime.agentFallbacks`, write it with a `recordAdapterFailure` helper beside
`recordAgentFallbacks`, and read it in `applyPostRunInspection`. Last-write-wins
per story is sufficient — post-run runs immediately after that story's plan, so
the last recorded failure is the failing op's. Ad-hoc calls with no `storyId`
are not recorded, matching `recordAgentFallbacks`.

**File-size constraint:** `post-run.ts` is at 598 of the 600-line limit and the
gate forbids any growth. The change there is net-negative (removing the
`"will retry"` block frees three lines), but it must stay so.

`turnResultToAgentResult` (`build-hop-callback.ts:107`) also hardcodes
`rateLimited: false` on the non-throwing path, so the field is inconsistently
populated even before it is discarded. Derive it there from the same
`adapterFailure` the function already forwards.

Drop the `"will retry"` wording at `post-run.ts:573`: nothing at that layer
retries, and the next statement is `cleanupSessionOnFailure` followed by
`{ action: "escalate" }`.

Do **not** take #1897's option 2 (deleting the branches). That loses the
diagnostic this spec exists to gain.

### 3.4 Configuration

Reuse the existing `agent.native.transportRetry` (`{maxAttempts, baseDelayMs}`)
rather than adding a knob. The semantics are identical — bounded retry of a
fault the turn loop can cheaply re-issue — and `baseDelayMs` applies only when
the provider supplies no `retryAfter`. A dedicated rate-limit bound can be
added later if telemetry shows it is wanted.

No config migration. No schema change.

## 4. Out of scope

All of the following belong to spec 2 and must not be touched here:

- the binding lattice and peer bindings for an `(agent, tier)` slot
- replacing agent-swap with binding-swap
- `markUnavailable` becoming a cooldown with an expiry, and decoupling swap
  from prune (#1883)
- a same-binding retry arm for `fail-service-down` (#1884)
- the `AdapterFailure.category` two-value problem, and the two documented lies
  it forces (`context-overflow` filed as availability; `fail-timeout` filed as
  quality)
- `decideStageAction`'s pause-vs-escalate routing (#1892), which is governed by
  a standing 2026-05 ruling

### Accepted residue

After this spec, a native 429 that **outlives** the turn-loop wait still dies
terminally: it reaches the manager, `decideSwap` accepts on `availability`,
`nextCandidate` searches an agent-keyed map that native cannot populate
(`agent.protocol: "native"` requires `agent.default: "native"`, so the agent
axis has exactly one value), returns `null`, and `onSwapExhausted` fires with
`hops: 0` — with the backoff unreachable one branch away.

This cliff is **deliberately left in place**. A three-line palliative exists
(fall through to the backoff when `nextCandidate` returns `null`), and was
declined so that spec 2 designs the exhaustion path once rather than inheriting
a patch. Ruled 2026-09-07.

## 5. Behaviour changes to expect

1. **A thrown 4xx stops being retried.** A thrown 401 currently gets three
   attempts at 250/500ms; afterwards it classifies as `auth` and gets zero.
   Correct, but such failures surface roughly 750ms sooner than today.
2. **A thrown 503 moves up a tier.** It currently files as `transport` and is
   retried inside nax-ai without jitter. Afterwards it files as `overloaded`,
   which `isRetryableErrorEvent` declines, so it propagates to nax's turn loop
   and is retried there with equal jitter and the provider's `retryAfter`. Net
   improvement, but the retry log line moves from `nax-ai` to `native-adapter`.
3. **Wall-clock per turn can grow.** A turn that previously failed fast on a
   429 may now wait the advertised `retryAfter` before re-issuing, bounded by
   `maxAttempts` and by the fail-fast rule in 3.2. This trades a fast failure
   for a slow success and is intended; it should not be read as a hang.

## 6. Verification anchors

Behavioural runtime cases, not grep or file-content assertions.

| # | case | expects |
| --- | --- | --- |
| 1 | nax-ai: thrown value carrying `status: 429` and a `retry-after: 30` header | classifies `rate-limit` with `retryAfter: 30`; `retryTransportFaults` does **not** retry it |
| 2 | nax-ai: thrown value with no status (connection reset) | still `transport`; still retried at 250ms then 500ms |
| 3 | nax-ai: thrown value carrying `status: 401` | classifies `auth`; not retried |
| 4 | nax: native 429 through `sendTurn` | resulting `AdapterFailure.retryAfterSeconds === 30` |
| 5 | nax: turn loop, 429 with `retryAfter: 30`, 300s remaining | waits ~30s, re-issues once |
| 6 | nax: turn loop, 429 with `retryAfter: 30`, 10s remaining | **no** retry; failure surfaces immediately |
| 7 | nax: turn loop, an `overloaded` fault arriving with no `retryAfter` | equal-jitter backoff from `baseDelayMs` — the existing path, unchanged by this spec |
| 8 | nax: acpx `fail-rate-limit` carrying `retryAfterSeconds: 45` at the manager | backs off 45s, not 2s |
| 9 | nax: story fails to a 429 | its `Agent session failed` log line reports `rateLimited: true` |

Cases 1 and 2 are a matched pair and both sides must be non-empty: 2 is the
regression guard proving the widening did not swallow the connection-reset case
the function was originally written for. Likewise 5 and 6, and 1 and 3.

## 7. Landing order

1. nax-ai: `classifyThrown` plus cases 1-3. Self-contained.
2. nax-ai release; bump the nax pin from `0.1.9`.
3. nax: `toAdapterFailure` signature, `RETRYABLE_KINDS`, the fail-fast rule,
   `defaultRetryStrategy`, and the #1897 carry-through, plus cases 4-9.

The nax side is inert until the pin moves. Nothing regresses in the interim;
the thrown-429 case simply stays as it is today.

## 8. What this unlocks for spec 2

Once rate limits are classified, carried, and reported, three questions become
answerable from ordinary run artifacts rather than from reasoning:

1. **The `retryAfter` distribution on native.** This decides spec 2's ladder
   directly. Mostly seconds means wait-first dominates and peer-swap is a rare
   fallback; mostly minutes or absent means the peer binding is the primary
   move.
2. **How often an op dies at the exhaustion cliff** (`onSwapExhausted` with
   `hops: 0`). This sizes spec 2's payoff.
3. **How many 429s the turn-loop wait absorbs outright.** If it absorbs nearly
   all of them, spec 2's peer map is worth materially less than the design
   discussion assumed.

Spec 2 should be written against those three numbers, after at least one real
run on the native global profile has passed through the fixed path.
