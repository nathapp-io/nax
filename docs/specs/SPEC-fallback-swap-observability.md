# SPEC: Make agent-swap outcomes observable on the `complete()` path and at the decline gate

## Summary

Two defects leave the agent-fallback subsystem unobservable from run artifacts. `AgentManager.completeAs`
builds a correct `AgentFallbackRecord[]` and then discards it, so every swap taken on the `complete()`
path is missing from `StoryMetrics.fallback.hops` and from the run-level aggregates. Separately,
`runWithFallback` returns terminally when `shouldSwap` declines, emitting nothing — so a run log cannot
distinguish a swap that was *refused* from one that was never *considered*.

This spec closes both. US-001 routes the `complete()` path's records to the same run-scoped sink the
`run()` path already uses. US-002 makes every `shouldSwap` decision carry the gate that decided it.

## Motivation

Issue #1712 and issue #1713, both found while verifying #1707 / #1709 against a real `nax run` on the
`fallback-probe` fixture.

For #1712: `runWithFallback`'s hops reach metrics because `callOp` calls `recordAgentFallbacks` at
`src/operations/call.ts:420`. The `complete()` path has no equivalent. `completeAs`
(`src/agents/manager.ts:749`) returns `outcome.result` and drops `outcome.fallbacks`, even though a
genuine `claude -> opencode` swap was logged by `completeWithFallback` in the same run. The resulting
`metrics.json` entry carries no `fallback` key at all.

For #1713: the decline at `src/agents/manager.ts:345` is the only one of three terminal exits in that
region that is silent. The `fail-stale` no-candidate exit logs a warning at `:349`, and the exhausted
exit emits `onSwapExhausted` at `:389`. Because the plain decline emits nothing, diagnosing a real
non-swap required eliminating each of `shouldSwap`'s six decline paths by hand against the effective
config, and the surviving candidate — the `hasBundle` guard — was reached by elimination rather than by
observation. Making the decision self-describing is what turns that from an investigation into a log line.

## Design

### Surfacing the `complete()` path's records

`AgentFallbackRecord[]` is result-side data. Per `.nax/rules/adapter-wiring.md` Rule 6 it must not be
threaded back through `CallContext` as a new field; it travels as a sibling return value, which is
exactly the shape `runWithFallback` already uses via `AgentRunOutcome`. `AgentCompleteOutcome`
(`src/agents/manager-types.ts:53`) is the matching carrier and already exists.

`IAgentManager` gains one method alongside the existing `completeAs`:

```ts
completeAsWithFallback(agentName: string, prompt: string, options: CompleteOptions): Promise<AgentCompleteOutcome>;
```

`AgentManager.completeAs` keeps its current signature and becomes a thin unwrap over it, so the three
callers that do not need the records — `AgentManager.complete` (`src/agents/manager.ts:621`) and the two
debate resolvers (`src/debate/resolvers.ts:46` and `:90`) — are untouched. `callOp`'s complete branch
(`src/operations/call.ts:107`) switches to the new method and calls `recordAgentFallbacks(ctx, outcome.fallbacks)`,
the same sink and the same helper the run branch uses. `recordAgentFallbacks`
(`src/operations/call-resolvers.ts:140`) already no-ops for calls carrying no `storyId`, appends to any
existing per-story array, and needs no change.

The swap record built at `src/agents/manager.ts:575` omits `storyId`, while the fail-stale retry record
at `:538` sets it from `options.storyId`. `toFallbackHops` (`src/metrics/tracker.ts:239`) backfills the id
from the store key, so this is currently harmless — but the two records in one function disagreeing is a
trap for the first consumer that reads the raw records, and the fix is one field.

### Making the decline observable

`shouldSwap` (`src/agents/manager.ts:196`) returns a bare boolean and has **six** distinct decline paths:
absent failure; a refused `fail-aborted` / `fail-timeout` outcome; fallback disabled; no bundle; the hop cap
reached; and — found during implementation, and missed by this spec's first revision, which said five — the
`onQualityFailure` fallthrough, which declines a quality failure when the flag is off. It is the only decline
that is not an explicit `return false`, which is why counting early returns undercounts it. The decision becomes a discriminated result carrying which gate decided it, so both call
sites — `:345` on the run path and `:560` on the complete path — can report the reason rather than
re-deriving it.

The boolean `shouldSwap` stays on `IAgentManager` with its current signature and semantics, because
existing fakes and callers depend on it; the reason-carrying form is a sibling that `shouldSwap` delegates
to. That keeps this story's interface change additive.

The run path's decline at `:345` then logs at `warn` with the deciding reason plus the failure's outcome
and category, before the branch's existing `fail-stale` / rate-limit-backoff / exhausted handling runs. It
must not displace those: the `fail-stale` warning at `:349` and the `onSwapExhausted` emit at `:389` (and its sibling at `:411`) are
separate signals and both stay.

### Deliberately not asserted

Whether the `hasBundle` guard is what actually declines swaps on the `run()` path — and therefore whether
`agent.fallback.map` is largely inert for the main execution path — is **not** claimed here and is not in
scope. `ctx.contextBundle` is assigned at `src/pipeline/stages/prompt.ts:85` and
`src/pipeline/stages/context.ts:256`, and `releaseHeavyPipelineContext`
(`src/execution/iteration-runner.ts:46`) clears it after an iteration rather than before one, so the
naive reading is unsupported. US-002 exists to make that question answerable from a run log instead of by
reading. The answer belongs in a follow-up issue.

### Integration

`makeMockAgentManager` (`test/helpers/mock-agent-manager.ts:158`) returns its object literal through an
`as IAgentManager` cast at `:278`, so a new required interface method will **not** fail typecheck there —
it will fail at runtime, as an undefined call, in every test that drives `callOp`'s complete branch through
this mock. `fakeAgentManager` (`test/helpers/fake-agent-manager.ts:31`, whose returned literal is hard-typed at `:59`)
is declared `const mgr: IAgentManager` and will fail typecheck. Both helpers must gain the method, and the mock's
must be derivable from its existing `completeAsFn` / `completeWithFallbackFn` options so no caller of
either helper has to change.

`test/unit/session/manager-session-retry.test.ts:81` and
`test/unit/execution/lifecycle/run-setup-credentials.test.ts:8` reach `IAgentManager` through casts over
partial literals and do not exercise the complete path; they need no change.
`wrapAdapterAsManager` no longer exists — ADR-020 Wave 2 removed it, and only stale comments still name it.

## Out of Scope

- Confirming or refuting the `hasBundle` hypothesis for the `run()` path, and any change to the
  `hasBundleForSwap` guard at `src/agents/manager.ts:344`, are not addressed; US-002 exists to produce the
  evidence for that decision, not to act on it.
- Changing `shouldSwap`'s decision semantics is not addressed — the same inputs must yield the same
  swap/no-swap outcome before and after this spec. Only the reason becomes observable.
- Recording fallback hops for calls that carry no `storyId` (plan, review outside a story, CLI) is not
  addressed; `recordAgentFallbacks` deliberately no-ops for them because the store is keyed by story.
- The story-metrics back-fill domain — a story that spends nothing getting no `StoryMetrics` row, and a
  batch sibling getting none at all — is not addressed here. That is issues #1714 and #1721 and has its
  own spec.
- Emitting a new `DispatchEvent` or `AgentManagerEvents` member for the declined decision is not
  addressed; US-002 uses the existing logger, matching its two emitting neighbours.
- Batch siblings under-counting swap hops is intended behaviour, not a defect: one batch is one session and
  one swap event, and the aggregates that read the field would multiply it.

## Stories

**US-001 — Route `complete()`-path swap records to the run-scoped sink** *(no dependencies)*

Add `completeAsWithFallback` to `IAgentManager` and `AgentManager`, returning the `AgentCompleteOutcome`
that `completeWithFallback` already produces. Reduce `completeAs` to an unwrap over it so its callers and
its signature are unchanged. Switch `callOp`'s complete branch to the new method and record the outcome's
records through `recordAgentFallbacks`. Set `storyId` on the swap record built in `completeWithFallback`,
matching the fail-stale retry record in the same function. Give both shared test helpers the new method.

- Context Files: `src/agents/manager.ts`, `src/agents/manager-types.ts`, `src/operations/call.ts`, `src/operations/call-resolvers.ts`, `src/metrics/tracker.ts`, `test/helpers/mock-agent-manager.ts`, `test/helpers/fake-agent-manager.ts`

**US-002 — Report the gate that declined a swap** *(no dependencies)*

Give the swap decision a reason-carrying form that names which of `shouldSwap`'s six gates declined,
keeping the existing boolean `shouldSwap` intact and delegating to it. Log the declined decision at the run
path's decline site with that reason plus the failure's outcome and category, without displacing the
`fail-stale` warning or the `onSwapExhausted` emit that follow it.

- Context Files: `src/agents/manager.ts`, `src/agents/manager-types.ts`, `src/agents/retry/types.ts`
- The fixtures for this story drive a **declined** swap (fallback disabled, hop cap reached, or a refused
  outcome). US-001's fixtures drive a swap that is **taken**; neither story's fixtures can exercise the
  other's branch.

### Seams

- **US-001 produces the `completeAsWithFallback` method that both shared test helpers consume.**
  `makeMockAgentManager` returns through an `as IAgentManager` cast, so its omission is invisible to
  typecheck and surfaces only as an undefined call at runtime inside `callOp`'s complete branch. The
  criterion that pins this must therefore call the helper and invoke the method, not merely construct it.
  Pinned by US-001 AC-6.
- **US-001 consumes `recordAgentFallbacks` and `ctx.runtime.agentFallbacks` unchanged.** Both already exist
  and are exercised by the run path; US-001 adds a second writer, so its criteria must assert that records
  from the two paths **accumulate** for one story rather than replacing each other.
- **US-002 does not consume US-001.** The two stories touch different functions in `src/agents/manager.ts`
  and can land in either order; they are listed together because they are one file and one review.

### Modifies

**US-001**

- `src/agents/manager.ts` — `completeAs` must stop returning `outcome.result` directly and delegate to the new `completeAsWithFallback`; the swap record built in `completeWithFallback` must carry `storyId`.
- `src/agents/manager-types.ts` — `IAgentManager` gains `completeAsWithFallback`; the existing `completeAs` declaration is unchanged.
- `src/operations/call.ts` — the complete branch must call the new method and record the outcome's fallbacks through the existing sink.
- `test/helpers/mock-agent-manager.ts` — must gain `completeAsWithFallback`, derived from the existing `completeAsFn` / `completeWithFallbackFn` options so existing callers of this helper keep working unchanged. This authorisation covers adding that method and its option plumbing only; the helper's existing mock behaviours are relied on across the suite and must not be weakened.
- `test/helpers/fake-agent-manager.ts` — must gain `completeAsWithFallback`; it is hard-typed as `IAgentManager` and will otherwise fail typecheck.

**US-002**

- `src/agents/manager.ts` — the swap decision must expose which gate declined it, and the run path's decline site must log that reason; the boolean `shouldSwap` keeps its signature and its swap/no-swap semantics.
- `src/agents/manager-types.ts` — declares the reason-carrying decision shape alongside the unchanged `shouldSwap`.

## Acceptance Criteria

### US-001 — Route `complete()`-path swap records to the run-scoped sink

1. `[unit]` `completeAsWithFallback` on a real `AgentManager`, with a primary agent whose adapter fails with an availability outcome and a fallback map naming a second agent whose adapter succeeds, resolves to an outcome whose `fallbacks` array has one record and whose `result.output` is the second agent's output.

2. `[unit]` `completeAs` on that same manager and the same failing-primary configuration resolves to a `CompleteResult` whose `output` is the second agent's output — the unwrap preserves the pre-existing return contract.

3. `[unit]` Driving `callOp` through a complete-kind op with a `storyId` set, against a manager whose `completeAsWithFallback` reports one swap record, leaves `ctx.runtime.agentFallbacks` holding one record under that story's id.

4. `[unit]` Driving that same complete-kind op **twice** against the same `CallContext`, with one swap record reported each time, leaves `ctx.runtime.agentFallbacks` holding two records under that story's id, in call order — a second writer accumulates rather than replacing.

5. `[unit]` Driving that complete-kind op with `ctx.storyId` unset, against a manager reporting one swap record, leaves `ctx.runtime.agentFallbacks` empty.

6. `[unit]` The object returned by `makeMockAgentManager` with no options resolves a `completeAsWithFallback` call to an outcome with a `result` and an empty `fallbacks` array, rather than throwing — and when constructed with a `completeAsFn` override, the outcome's `result` is that override's value.

7. `[unit]` A swap record produced by `completeWithFallback` for a call whose options carry a `storyId` has that id on the record itself, matching the fail-stale retry record the same function builds.

### US-002 — Report the gate that declined a swap

Fixtures for every criterion below configure a swap that is **declined**, unlike US-001's fixtures, which configure a swap that is taken.

1. `[unit]` The reason-carrying decision, given an availability failure with `agent.fallback.enabled` false, reports no swap and names the disabled-fallback gate.

2. `[unit]` Given an availability failure, fallback enabled, and `hopsSoFar` equal to the configured `maxHopsPerStory`, the decision reports no swap and names the hop-cap gate — distinct from the value AC-1 returns.

3. `[unit]` Given a `fail-aborted` failure with fallback enabled and no hops taken, the decision reports no swap and names the refused-outcome gate.

4. `[unit]` Given an availability failure, fallback enabled, hops under the cap, and `hasBundle` false, the decision reports no swap and names the bundle gate — distinct from the values AC-1 through AC-3 return.

5. `[unit]` The boolean `shouldSwap` returns `false` for each of the four declined inputs of AC-1 through AC-4, `false` for an undefined failure, and `true` for an availability failure with fallback enabled, `hasBundle` true and `hopsSoFar` below the cap — the reason-carrying form and the boolean agree on every gate.

6. `[unit]` Running `runWithFallback` against a captured logger, with a failure that reaches the decline gate with fallback disabled, produces a log entry whose fields carry `storyId`, the deciding gate, the failure's outcome, and the failure's category — `storyId` is mandated by `.nax/rules/project-conventions.md` and is already carried by both neighbouring decline logs.

7. `[unit]` In that same declined run, the `fail-stale` no-candidate warning is **not** emitted, confirming the new log is an addition at the decline site rather than a replacement of a neighbouring signal.

8. `[unit]` Running `runWithFallback` with an availability failure and hops already at the cap emits both the new decline log and the `onSwapExhausted` event, confirming the exhausted path retains its existing signal.
