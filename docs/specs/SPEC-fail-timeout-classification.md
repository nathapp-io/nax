# SPEC: Wall-clock timeout classification and bounded informed retry

<!-- spec-writing: completed-through-phase-6 -->
<!-- spec-review: phases 1-8 clean (2026-07-27); phase 9 pending `nax plan` -->

## Summary

A wall-clock timeout on an agent turn currently returns empty output, which the
hop body synthesises into `fail-stale` — the outcome reserved for an *idle*
agent. The manager then restarts the same agent up to three times, each with a
full fresh timeout budget, so every timeout costs roughly four times its
configured budget before reaching a terminal story failure.

This spec introduces a distinct `fail-timeout` classification, replaces the
three blind restarts with **one** retry at **half** the budget on a **fresh**
session, and gives that retry a prompt that states what the previous attempt
left on disk. `fail-stale` behaviour is unchanged in every respect.

## Motivation

From `docs/findings/2026-07-26-bot-command-groups-test-writer-loop.md` §5.4.

A test-writer session burned ~7,900 tool calls over 3.5 hours. The wall-clock
timeout fired three times at exactly 60-minute intervals; each firing restarted
the turn with an identical prompt, a fresh session, and no memory of the prior
attempt. The chain:

1. `src/agents/acp/adapter.ts:468` — on timeout, `sendTurn` breaks its turn loop
   with `lastResponse` still `null`. The local `timedOut` flag is never
   returned, so the fact of the timeout dies with the stack frame.
2. `extractOutput(null)` yields `""`.
3. `src/operations/call.ts:316` synthesises
   `{ outcome: "fail-stale", category: "availability", retriable: true }`.
4. `src/agents/manager.ts:293` matches `outcome === "fail-stale"` and retries the
   same agent up to `agent.idleWatchdog.maxRetryAttempts ?? 3` times.

Two defects follow. First, nax labels a **maximally busy** agent as **idle** —
the semantic opposite. Second, the restarts carry no information the previous
attempt lacked, so they are not three attempts but one attempt executed four
times.

This is not specific to the incident, nor to the test-writer: `fail-timeout`
originates at the adapter/manager layer and applies to every run-kind op —
implementer, verifier, both reviewers, plan, acceptance.

Retry is nonetheless warranted, for a reason particular to this system: **the
session dies but the agent's file edits do not.** Attempt 2 does not redo
attempt 1, it continues from whatever landed on disk. That also fixes the
budget shape — an agent that was progressing needs *less* time on the second
pass, and an agent that was looping should have its waste capped. Decaying
budget is correct in both branches.

## Design

### Integration

Pure extension. Verified symbols and integration points:

| Symbol | Location | Role |
|:---|:---|:---|
| `TurnResult` | `src/agents/types.ts:444` | Gains one optional `timedOut?: boolean` field |
| `sendTurn` timeout branch | `src/agents/acp/adapter.ts:468` | Sets the flag it already computes locally |
| `sendWithFileOutput` | `src/operations/call.ts:316` | Maps the transport fact to a policy outcome |
| `AdapterFailure.outcome` | `src/context/engine/types.ts:49` | `"fail-timeout"` **already declared**; currently unused |
| `HopKind` | `src/agents/manager-types.ts:15` | Gains a `timeout-retry` variant |
| `executeHop` | `src/agents/manager-types.ts:84` | Already receives per-hop `resolvedRunOptions` — carries the reduced budget |
| `runWithFallback` | `src/agents/manager.ts:222` | Gains a `fail-timeout` branch beside the existing `fail-stale` one |
| `shouldSwap` | `src/agents/manager.ts:194` | Unmodified; `category: "quality"` routes through its existing branch |
| `RectifierPromptBuilder.swapHandoff` | `src/operations/build-hop-callback.ts:145` | Precedent for hop-conditional prompt rewriting |
| `captureGitRef` | `src/utils/git.ts:90` | Supplies the pre-attempt ref for the progress signal |
| `agent.idleWatchdog.maxRetryAttempts` | `src/config/schemas-infra.ts:237`, `.default(3)` | Unchanged; governs `fail-stale` only |
| `agent.timeoutRetry.maxAttempts` | **new** config key, default `1` | Timeout-retry attempt limit |
| `agent.timeoutRetry.budgetMultiplier` | **new** config key, default `0.5` | Fraction of the prior hop's `timeoutSeconds` granted to the retry |

Three design decisions carry non-obvious rationale:

**`category: "quality"`, not `"availability"`.** `shouldSwap` returns `true` for
`availability`, and the swap path calls `markUnavailable(currentAgent, …)`
(`manager.ts:574`), which prunes that agent for the remainder of the run. A
single slow story would poison the agent pool for every subsequent story.
`quality` routes to `fallback.onQualityFailure ?? false`, leaving swap opt-in.

**A new `timeout-retry` hop kind, not a reuse of `stale-retry`.**
`build-hop-callback.ts:182` resolves `stale-retry` by reusing the live session
handle via `getLiveHandle`. A wall-clock timeout *terminated* the session, so
reusing that variant would hand the retry a dead handle.

**`retriable: true`.** The pre-existing contract test at
`test/unit/agents/fail-stale-complete.test.ts:64` specifies
`retriable: false` for a wall-clock timeout. That test constructs an object
literal and asserts on it — it never exercises production code — so nothing
breaks. This spec deliberately overrides that earlier intent on the grounds of
cumulative on-disk progress, which the original design did not account for.

### File-size ratchet compliance

`scripts/baselines/file-sizes-baseline.json` pins every grandfathered file at
its exact current length, and `check:file-sizes` runs inside `bun run lint`
(`SRC_LIMIT = 600`). Four of the files this feature touches sit at zero
headroom, so **a single added line fails the quality gate**:

| File | Baseline = current | Plan |
|:---|---:|:---|
| `src/prompts/builders/rectifier-builder.ts` | 902 | **Not modified.** `timeoutRetry` is authored in `rectifier-builder-helpers.ts` (409/600) instead |
| `src/agents/manager.ts` | 820 | Move the existing fail-stale retry block **verbatim** into a new `src/agents/retry/hop-retry-policy.ts`, then add the fail-timeout branch there. Net ≈ −19 |
| `src/operations/call.ts` | 631 | Move the existing empty-output synthesis **verbatim** into a new `src/operations/turn-failure-classification.ts`, then add the timeout branch there. Net ≈ −11 |
| `src/agents/acp/adapter.ts` | 636 | Move `sendTurn`'s result assembly into the existing `src/agents/acp/adapter-output.ts` as `buildTurnResult`, which then carries `timedOut`. Net ≈ −10 |

Files with headroom, edited in place: `src/agents/types.ts` (558),
`src/agents/manager-types.ts` (243), `src/operations/build-hop-callback.ts`
(298), `src/prompts/builders/rectifier-builder-helpers.ts` (409).

Each extraction must be **net-negative** — moving N lines out while adding an
import nets −N+1 — so the parent ends below its baseline entry and the ratchet
is satisfied without a baseline bump.

> **The two verbatim moves touch fail-stale code.** They are relocations with
> no logic change: same conditions, same field values, same order. This is the
> only way to create headroom in `manager.ts` and `call.ts` without unrelated
> scope. US-002.9 and US-001.6 exist to prove `fail-stale` behaviour is
> unchanged across the move.

Prompt authoring stays inside `src/prompts/builders/` as
`forbidden-patterns.md` requires; `rectifier-builder-helpers.ts` is the
established sibling pattern for helper functions in that directory, and
`timeoutRetry` is re-exported from the `src/prompts` barrel.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Turn result already carries an `adapterFailure` | Timeout classification does not overwrite it |
| Pre-attempt git ref unavailable or capture fails | Retry prompt degrades to the generic preamble; no throw |
| Retry also times out | Terminal story failure; no third hop (unchanged from today) |

## Out of Scope

- Repetition or tool-call-loop detection (signature hashing of repeated tool calls) is deferred; this spec does not detect that an agent is looping, only that it exceeded its budget.
- A per-turn tool-call ceiling is deferred; the number of tool calls within a single turn remains unbounded.
- Disk-based recovery of an op's deliverable is deferred; no op gains an `op.recover` hook, and artifact presence is never treated as completion.
- Preserving an agent's partial message output across a timeout is deferred; `extractOutput` continues to yield `""` when the turn timed out.
- Permanent changes to the test-writer's standing prompt are deferred; the only prompt change is the retry-time injection defined here.
- Making wall-clock timeouts trigger tier escalation is out of scope. A timeout that exhausts its retry remains a terminal story failure via `runner.ts:87`, exactly as today.
- The `complete`-kind timeout path is out of scope; `adapter.complete` throws `AGENT_TIMEOUT` (`adapter.ts:190`) and never entered the fail-stale ladder.
- The `_runHop` / `session-run-hop` dispatch path is out of scope. It constructs results with `success: true` unconditionally (`session-run-hop.ts:74`) and so reports a timeout as success — a separate latent defect requiring its own spec.
- No change to `fail-stale` semantics, its retry count, its category, its reason field, or the idle-watchdog path that produces it.
- US-003 only: concurrent timeout retries across parallel stories share no counter state; each `runWithFallback` call owns its own attempt count, and cross-story rate limiting of timeouts is deferred.

## Stories

| ID | Title | Depends on |
|:---|:---|:---|
| US-001 | Classify wall-clock timeouts as `fail-timeout` | — |
| US-002 | One budget-decayed retry on a fresh session | US-001 |
| US-003 | Informed retry prompt with progress signal | US-002 |

**US-001 — Classify wall-clock timeouts as `fail-timeout`**

Surface the timeout as a transport fact on `TurnResult` and map it to a policy
outcome at the wiring layer, leaving the adapter free of policy naming (the
convention `SessionTurnError` already documents). With only this story landed, a
timeout produces a single hop and a terminal failure.

- Context Files: `src/agents/types.ts`, `src/agents/acp/adapter.ts`, `src/agents/acp/adapter-output.ts`, `src/operations/call.ts`, `src/context/engine/types.ts`
- Creates: `src/operations/turn-failure-classification.ts`
- Verification note: the two verbatim moves must leave `call.ts` and `adapter.ts` below their baseline entries — confirmed by `bun run lint`.

**US-002 — One budget-decayed retry on a fresh session**

Add a `fail-timeout` branch to `runWithFallback` with its own attempt counter,
passing a reduced `timeoutSeconds` on the retry hop and opening a fresh session.

- Context Files: `src/agents/manager.ts`, `src/agents/manager-types.ts`, `src/operations/build-hop-callback.ts`, `src/config/schemas.ts`, `src/config/schemas-infra.ts`
- Creates: `src/agents/retry/hop-retry-policy.ts`
- Verification note: the verbatim move of the fail-stale block must leave `manager.ts` below its baseline entry — confirmed by `bun run lint`.

**US-003 — Informed retry prompt with progress signal**

Compose the retry prompt from a generic timeout preamble plus guidance
conditioned on whether the working tree changed during the timed-out attempt.

- Context Files: `src/operations/build-hop-callback.ts`, `src/prompts/builders/rectifier-builder-helpers.ts`, `src/prompts/index.ts`, `src/utils/git.ts`
- Creates: none (`timeoutRetry` is added to the existing helpers file, which has headroom)

### Seams

| Producer | Consumer | Invariant |
|:---|:---|:---|
| US-001 `fail-timeout` outcome | US-002 manager retry branch | US-002 drives `runWithFallback` with a hop returning `fail-timeout` and asserts a second hop is dispatched |
| US-002 `timeout-retry` hop kind | US-003 prompt rewrite | US-003 substitutes `timeoutRetry` on `_buildHopCallbackDeps`, drives the `executeHop` closure with `{ kind: "timeout-retry" }`, and asserts invocation with the original prompt |

## Acceptance Criteria

### US-001 — Classify wall-clock timeouts as `fail-timeout`

1. `[unit]` When `sendTurn` returns because its wall-clock timeout elapsed, the returned `TurnResult` has `timedOut` equal to `true` and `output` equal to the empty string.
2. `[unit]` When `sendTurn` returns normally within its budget, the returned `TurnResult` has `timedOut` absent or `false`.
3. `[unit]` Given a turn result with empty output and `timedOut` true, the synthesised `adapterFailure` has `outcome` equal to `"fail-timeout"`.
4. `[unit]` That same synthesised `adapterFailure` has `category` equal to `"quality"`.
5. `[unit]` That same synthesised `adapterFailure` has `retriable` equal to `true`.
6. `[unit]` Given a turn result with empty output and `timedOut` false or absent, the synthesised `adapterFailure` has `outcome` equal to `"fail-stale"` and `reason` equal to `"empty-output"`, unchanged from current behaviour.
7. `[unit]` Given a turn result that already carries an `adapterFailure`, a `timedOut` value of true does not replace that existing failure.
8. `[unit]` `shouldSwap` returns `false` for an `AdapterFailure` with `outcome` `"fail-timeout"` and `category` `"quality"` when `agent.fallback.onQualityFailure` is unset.
9. `[integration]` After `runWithFallback` receives a hop result whose `adapterFailure.outcome` is `"fail-timeout"`, the dispatched agent is not recorded as unavailable for subsequent calls.

### US-002 — One budget-decayed retry on a fresh session

1. `[integration]` When the first hop returns a `fail-timeout` result, `runWithFallback` dispatches exactly one additional hop.
2. `[integration]` The additional hop receives a `timeoutSeconds` equal to half the value the first hop received.
3. `[integration]` When the retry hop also returns `fail-timeout`, no third hop is dispatched and `runWithFallback` returns a failing outcome.
4. `[unit]` A `HopKind` value of `{ kind: "timeout-retry", attempt: 1 }` is distinguishable from `{ kind: "stale-retry", attempt: 1 }` by its `kind` field.
5. `[integration]` When `executeHop` is invoked with a `timeout-retry` hop kind, it opens a new session rather than reusing the cached live handle that `stale-retry` reuses.
6. `[unit]` Constructing the configuration with `agent.timeoutRetry.maxAttempts` unset yields a resolved value of `1`.
7. `[unit]` Constructing the configuration with `agent.timeoutRetry.budgetMultiplier` unset yields a resolved value of `0.5`.
8. `[integration]` With `agent.timeoutRetry.maxAttempts` set to `0`, a `fail-timeout` result produces exactly one hop and no retry.
9. `[integration]` When the first hop returns a `fail-stale` result, the number of same-agent retries dispatched still equals `agent.idleWatchdog.maxRetryAttempts`, unchanged by this story.
10. `[integration]` A `fail-timeout` outcome that exhausts its retry budget causes the calling operation to surface no output, producing the same terminal failure path as an exhausted `fail-stale`.

### US-003 — Informed retry prompt with progress signal

1. `[unit]` `timeoutRetry`, imported from the `src/prompts` barrel, returns a string that includes the original prompt text passed to it.
2. `[unit]` Given a non-empty list of changed file paths, the returned prompt names each path and instructs the agent to continue from the existing state rather than restart.
3. `[unit]` Given an empty list of changed file paths, the returned prompt states that the previous attempt produced no file changes and instructs the agent to change its approach.
4. `[unit]` Given an empty list of changed file paths, the returned prompt does not instruct the agent to continue from existing work.
5. `[unit]` The returned prompt states the elapsed duration of the timed-out attempt.
6. `[integration]` When the `executeHop` closure is invoked with a `timeout-retry` hop kind, the `timeoutRetry` entry substituted on `_buildHopCallbackDeps` is called exactly once, with the original prompt and the list of changed file paths.
7. `[integration]` When the `executeHop` closure is invoked with a `primary` or `stale-retry` hop kind, the `timeoutRetry` entry on `_buildHopCallbackDeps` is not called.
8. `[unit]` When the pre-attempt git reference is unavailable, prompt construction returns the generic timeout preamble without raising.

**Out of scope:** concurrent timeout retries across parallel stories share no
counter state in this spec — each story's `runWithFallback` call owns its own
attempt count, and cross-story rate limiting of timeouts is deferred.
