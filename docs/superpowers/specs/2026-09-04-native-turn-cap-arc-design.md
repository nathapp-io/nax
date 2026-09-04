# Native turn-cap arc — design

Date: 2026-09-04
Issues: [#1819](https://github.com/nathapp-io/nax/issues/1819), [#1820](https://github.com/nathapp-io/nax/issues/1820), [#1821](https://github.com/nathapp-io/nax/issues/1821), [#1822](https://github.com/nathapp-io/nax/issues/1822)
Branch: `feat/native-turn-cap-arc`

## Problem

On the native transport, 44% of all run-path LLM calls stop at exactly turn 10 and
nothing reports it. Measured across four fixtures and several models
(`~/.nax/<project>/prompt-audit/*/*.jsonl`): 24 of 55 calls at turn 10, and all nine
near-empty responses occurred at turn 10 with zero at any other turn.

`turn-loop.ts:82` exits its `while (roundTrips < maxTurns)` silently: no warn, no flag
on `TurnResult`, only `internalRoundTrips`. The ACP adapter warns in the same situation
(`acp/adapter.ts:555`), so this is a straight parity gap.

The value being spent as that cap is `agent.maxInteractionTurns`, which is documented
as the human Q&A budget (`config-descriptions.ts:255`, counting `InteractionExchange`
from #1226). Two call sites feed it into `SendTurnOpts.maxTurns`
(`session-run-hop.ts:62`, `build-hop-callback.ts:427`). No knob for the round-trip cap
has ever existed — only `DEFAULT_MAX_TURNS = 10` and `?? 10` / `?? 1` literals.

### Why the two transports are not comparable

One **acpx** iteration is a complete autonomous agent run. `runSessionPrompt`
(`adapter-lifecycle.ts:214`) races a timeout against a single `session.prompt()`, which
resolves only once the sub-agent has finished; the loop continues only for nax-side
interaction. The agent's own tool calling happens entirely inside one iteration.

One **native** iteration is a single LLM completion (`turn-loop.ts:83-105`) — nax
executes the returned tool calls and loops. Native *implements* the agentic loop that
acpx delegates to a sub-agent process.

So `maxTurns = 10` means ten full agent sessions on acpx and ten LLM calls for an entire
story on native. The same is true of `timeoutSeconds`: it bounds a full agentic round on
acpx and one LLM call on native. **Parity in this arc means parity of guard posture and
outcome classification, never parity of numbers.**

### Why it stayed invisible

nax detects the symptom and misdiagnoses it as staleness. `agent-manager` logs
`fail-stale: immediate same-agent retry` with `{"reason":"empty-output","agent":"native"}`
— 16 such retries across three projects. The session was not stale; it spent its budget,
and the retry re-runs against the same budget.

Two guards exist and the silent class sits **between** them: `empty-output` → fail-stale
catches entirely empty output, and `sendWithParseRetry` catches JSON-shaped roles. A
prose role emitting *some* text ("All green. Let me verify the final state of the file:")
falls through both. Recovery today is accidental and only reaches structured-output
roles, whose truncated text fails a JSON parse.

## Goal

A coding agent working a story must not be bounded by round-trip count. Replace the
count-based bound with time-based guards at parity with acpx, and make truncation a
first-class, correctly-classified outcome.

## Design

### 1. One budget, applied at the right scope

No new config key. `timeoutSeconds` already flows end to end: per-op `timeoutMs` (plan
600s, ground 1800s, …) or `execution.sessionTimeoutSeconds` (default **3600**) →
`call.ts:202` / `build-hop-callback.ts:355,382` → `session-run-hop.ts:43` →
`manager.ts:482` → `native/session/session.ts:42` → `adapter.ts:180`.

`execution.sessionTimeoutSeconds` is described as "Timeout per agent coding session" and
defaults to the same 3600 that acpx uses in practice (`acpx --timeout 3600`, one hour for
one prompt, i.e. one full agent run). The semantics were always right. Native simply
applies a per-session budget to a single LLM call: `adapter.ts:185-196` builds the
`AbortController` and `setTimeout` *inside* the `complete()` closure, so every round-trip
gets a fresh full hour and total duration is bounded only by `maxTurns × timeoutSeconds`.

- Compute `deadline = now + timeoutSeconds * 1000` **once per turn** in `runNativeTurn`.
- Each `complete()` arms its controller with the **remaining** budget, still combined
  with `opts.signal` via `AbortSignal.any`.
- Apply the same whole-turn bound to acpx, where `adapter.ts:422` re-arms per iteration.
  #1822 is a both-transports defect.

Net user-visible config change: **zero**. No key added, renamed, or removed.

### 2. Split the counter, keep the key

`maxInteractionTurns` stays meaningful on native — it bounds human Q&A round trips, which
is its documented purpose on both transports. What changes is that it stops being spent
as the agent round-trip cap.

- `roundTrips` becomes uncapped telemetry (`internalRoundTrips`); the `while` condition
  and `DEFAULT_MAX_TURNS` are removed.
- A second counter tracks `kind: "question"` exchanges, and **that** is what
  `maxInteractionTurns` bounds.
- Native populates `TurnResult.interactions`, which today is set only by
  `acp/adapter.ts:402`.

`AdapterInteraction` already declares `{ kind: "question"; text: string }`
(`interaction-handler.ts:5`), but `turn-loop.ts:101-133` routes only `coding-tool` and
`context-tool`. On native the human Q&A channel is therefore currently **unreachable**,
while the key that names it is spent elsewhere.

Native gains an **ask-human tool**: a declared tool whose invocation routes to the
existing `interactionHandler` as `kind: "question"`, increments the exchange counter,
appends an `InteractionExchange`, and returns the operator's reply as a tool-result. A
structured tool call suits the native protocol better than acpx's output parsing
(`adapter.ts:477-500`), which exists there only because acpx has no structured channel.

### 3. Truncation as a first-class outcome

`classifyEmptyOutputFailure` (`turn-failure-classification.ts:27-48`) checks, in order:

1. `turn.adapterFailure` → return it
2. output non-empty → `null` (success)
3. `turn.timedOut` → `fail-timeout` / `wall-clock-timeout`, category `quality`
4. otherwise → `fail-stale` / `empty-output`, category `availability`

Native sets neither `adapterFailure` nor `timedOut`, so every capped turn falls to branch
4 — the 16 misdiagnoses above.

Branch 2 sits **above** branch 3, so a turn that hits its deadline while having produced
prose returns `null` and is classified as a clean success. That is the common truncation
case, so setting `timedOut` alone would fix nothing for it.

- **Native reports transport facts and does not classify**, per the contract already
  documented on `TurnResult.timedOut` ("the adapter never classifies *why* — the wiring
  layer does"). It sets `timedOut` when the whole-turn deadline fires, and marks the turn
  as ended-without-completing whenever the loop exits with tool calls still pending —
  that is, the model asked for work that was never executed and never answered.

  The set of exits that fact covers narrows across the arc, and that is intended. Under S1
  it covers the round-trip cap, the deadline, and an abort. Once S5 removes the cap, only
  the deadline and abort remain, because a loop with no count bound exits normally only
  when the model returns no tool calls. The fact is therefore defined by the *condition*
  (pending tool calls at exit), never by enumerating the exits, so no story has to revise
  its meaning.
- **The classifier checks transport facts before the non-empty short-circuit.** Non-empty
  output means success only if the turn actually completed. This one change closes the
  prose-role hole between the two existing guards.
- A deadline classifies as `fail-timeout` / `wall-clock-timeout` (branch 3, already
  correct), which ends the `fail-stale → immediate same-agent retry into the same budget`
  loop because `fail-timeout` is a different policy path.

**This changes acpx behaviour too**, deliberately. A turn that times out with partial
output is today classified as success and will become `fail-timeout`. Accepted: a
truncated turn is a truncated turn regardless of transport, and divergence here is what
produced the original confusion. Unlike native's, acpx's `timedOut` path does fire in
real runs, so this will reclassify turns that currently pass silently.

### 4. Native watchdog coverage

`manager.ts:482-489` already passes `onStreamActivity` and `onActiveCall` into
`openSession`; `NativeAgentAdapter` references neither, so `agent.idleWatchdog` is inert
on every native session in both `observe` and `cancel` modes.

- **Emit the events** at round-trip boundaries: `agent.call_started` once per turn (model,
  `timeoutSeconds`); per completion `usage_update` (tokens, cost), `message_update`
  (`deltaBytes` = text length), `thinking_update` when thinking blocks return; per executed
  tool `tool_call_update` (`toolName`); and `agent.call_ended` with
  `success | error | cancelled | timeout`. All four configured `activityKinds` are covered,
  so no configuration appears to work while silently doing less.
- **Register the cancel handle** via `onActiveCall(callId, cancel)`, where cancel aborts
  the turn-level `AbortController` from §1 — one handle serves both the deadline and the
  watchdog. Using the hook rather than rolling a private one also means
  `_buildOnActiveCall`'s bookkeeping records the callId in `_watchdogCancelledCalls`, which
  is what lets `sendPrompt` distinguish a watchdog cancel from an unrelated process kill.

Native emits only at boundaries, so a single in-flight completion looks idle. That is
correct: a *hung* call is already caught by the per-call timeout. The watchdog's unique job
is the productive-looking infinite loop — every call returns, the model never stops calling
tools — which emits `tool_call_update` each iteration and is caught by
`toolCallOnlyIdleTimeout` through `lastNonToolCallActivityAt`. That is precisely the one
case the round-trip cap uniquely caught, so removing the cap loses nothing.

The three bounds nest coherently on their defaults: idle 900s < tool-call-only 1800s <
whole-turn 3600s.

`idleWatchdog` defaults to enabled with `warn-then-cancel`, so native sessions become
cancellable as soon as this lands. That is a real live behaviour change, and it is exactly
the change that stops the configuration from lying.

## Stories

| # | Story | Depends on |
|---|---|---|
| S1 | Native reports transport facts: `timedOut`, turn-not-completed, plus the acpx-parity warn at loop exit | — |
| S2 | Whole-turn deadline on both transports; hoist the controller, per-call gets remaining budget | S1 |
| S3 | Classifier checks transport facts before the non-empty-output short-circuit | S1 |
| S4 | Native watchdog: emit the four activity kinds, register `onActiveCall` cancel | S2 |
| S5 | Remove the round-trip cap; split the counter so `maxInteractionTurns` bounds Q&A only | S2, S4 |
| S6 | Ask-human tool → `kind:"question"` → populate `TurnResult.interactions` | S5 |

The cap comes off last, after both replacement guards exist. S1 alone makes the 44%
visible without changing behaviour and is worth landing even if the arc stalls.

## Verification

Each behavioural claim needs a gate, and each regression test must be verified by
reintroducing the bug with **both sides non-empty**.

- **S3** — a turn with non-empty prose *and* not-completed must classify as a failure.
  Reintroduce the original branch order and confirm it flips to `null`. A test using empty
  output passes under both orderings and proves nothing.
- **S5** — assert no numeric round-trip bound exists on the native path by driving a turn
  past ten round-trips to completion. Restoring `DEFAULT_MAX_TURNS` must fail it.
- **S4** — with `idleWatchdog` enabled, a native session must log `Watchdog tracking call`.
  That line appears for acpx and never for native today, making it a clean before/after
  discriminator.

**Live run.** Re-run the `native-full-run` fixture on `nathapp-io/nax-context-dogfood`
**from a copy** — a nax run auto-commits onto the current branch. Measure the `turn` field
in `~/.nax/<project>/prompt-audit/*.jsonl`, which is `internalRoundTrips` via
`manager-dispatch.ts:91`. Baseline to beat: 24/55 calls (44%) at exactly turn 10, all nine
near-empty responses at turn 10 and zero elsewhere. Success is that correlation dissolving
— turn counts spread past 10 with no near-empty cluster. Cost anchor: 2/2 in 24m49s at
$0.0921.

## Risks

1. **The native deadline path has never fired in any run log.** `adapter.ts:194`'s abort is
   untested in practice, and it is unverified whether that throw is misclassified as
   `availability` by `build-hop-callback`'s catch. S2 carries a unit-level forced-deadline
   test; a dedicated end-to-end forced-timeout story was considered and deliberately not
   scoped.
2. **Removing the cap removes an incidental cost bound.** A pathological turn can now spend
   up to a full hour of model calls where it previously stopped at ten. Wall-clock is
   bounded; spend within it is not.
3. **The acpx reclassification in §3 will fail turns that currently pass silently.** This is
   intended, but it lands as a live behaviour change on the transport that carries most
   traffic.

## Out of scope

- Raising or tuning any timeout default. The existing 3600s is adopted as-is.
- #1816 (advisory findings print "(no description)"), #1817 (`pricingSource` mislabelling),
  #1818 (Git tool flag placement). Filed from the same fixture run but unrelated.
- Live evidence for #1812's seven fix-loop ops and `debate-plan`, which remains open
  separately.
