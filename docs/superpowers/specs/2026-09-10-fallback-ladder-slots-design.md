# Fallback ladder slots: correct swaps, sticky endpoints, ladder depth

**Date:** 2026-09-10
**Status:** Design — approved in brainstorming, not yet planned
**Closes:** #1965 (root cause established below). Builds on #1962, #1964, #1966, #1967 (PR #1970).

## Goal

A story must be able to walk its fallback ladder to the end, across every operation it
runs, on any transport:

- `native -> native` (a different provider behind the same agent), `native -> acp`, and
  `acp -> native` swaps all dispatch the endpoint that was selected.
- Warm implementer-family operations (`implement`, `autofix-implementer`,
  `full-suite-rectify-op`, `rectify`) stick to the endpoint the story swapped to.
- A sticky endpoint that fails again descends to the next rung rather than restarting at
  a dead primary or jumping past the remaining same-agent rungs.

Worked example, the acceptance shape for this design: the implementer rate-limits on
native A and swaps to native B; `autofix-implementer` dispatches native B; native B
rate-limits; the next hop is native C, not `claude` and not native A.

## Why this does not work today

Four defects, each of which alone makes the same-agent ladder inert.

### D1 — a reused session discards the new endpoint (#1965)

`SessionManager.openSessionImpl` caches live handles keyed on **name + agentName** and
returns the cached handle without reading `opts.modelDef`; `selectModel(opts)` is only
reached on the full open path. A same-agent hop therefore dispatches the *previous*
model.

Preconditions, all met in production:

- Session names carry no agent or hop segment
  (`formatSessionName`: `nax-<workdir hash>-<feature>-<story>-<role>`), so a same-agent
  hop asks for the name the previous hop opened.
- A cross-agent hop escapes, because `liveHandle.agentName === opts.agentName` fails —
  which is exactly the native/claude asymmetry seen in the field.
- `keepOpen` (warm lifetime) leaves the handle in `_liveHandles`; `closeSession` is the
  only thing that removes it.

Evidence, run `run-2026-09-09T13-58-46-234Z`, story US-005:

```
13:58:47.164  Session opened via SessionManager  agentName=native  resume=false
13:58:47.178  Agent call started  model=minimax/MiniMax-M3
13:58:58.995  Agent swap triggered  native -> native  hop=1
13:58:59.001  Agent call started  model=minimax/MiniMax-M3        <- no open log between
13:59:08.262  Agent swap triggered  native -> claude  hop=2
13:59:21.179  Session opened via SessionManager  agentName=claude  resume=true
```

`Session opened via SessionManager` is logged *after* the adapter open, so it fires only
on the full path. Hop 1 called `openSession` (every non-`stale-retry` hop does) and
produced no such line: it returned from the cache. The 6 ms between the swap and the call
start corroborates it, as does `closeStory` reporting that descriptor still `RUNNING`.
The absent `Session handed off` line at hop 1 is consistent rather than contradictory —
`recordAgentHandoff` early-returns when `descriptor.agent === newAgent`.

Reproduced deterministically: two `openSession` calls, same name and agent, different
`modelDef`, returns the first model. The cross-agent control returns the new one.

D1 also defeats stickiness, not just swaps: `autofix-implementer` declares
`session: { role: "implementer", lifetime: "warm" }`, so it shares the implementer's
session name and inherits the stale handle. #1967's escalated-tier inheritance is
observable today only when the agent happens to differ.

### D2 — the start rung has no identity

An operation that starts on a rung (sticky target, or `resolveStartAgent`'s dead-primary
skip) dispatches `HopKind: "primary"` with no `tier`/`model`, although the type documents
that case. On failure `markUnavailable` receives no endpoint identity and writes the
bare-agent key. `CooldownStore._live` deliberately refuses to let a model-scoped entry on
the bare key blanket the agent, so the mark is nearly inert for any narrower lookup —
while `resolveStartAgent`'s tier-less `isUnavailable(primary)` reads that same bare key
unconditionally, which diverts *other roles* off their own configured endpoints.

Net effect on the goal: a failure on native B cools `native` as a whole for the start
check, so the story leaves the native rungs entirely and lands on `claude`.

### D3 — the depth cap counts swap events per story

`maxHopsPerStory` is a cumulative per-story count of swap events. In the field run the
implementer alone spent both hops, and every later operation logged `hop-cap-reached`
(ten times), leaving the story stranded on a dead endpoint.

### D4 — the sticky key has no role

`runtime.storyAgentTargets` is keyed `(storyId, tier, agent)`, so any operation resolving
to the same agent and tier inherits a swap, reviewers included — a reviewer with its own
model pin can be silently redirected. Conversely, roles that should keep their own
position across their repeated invocations (semantic and adversarial reviewers each ran
three times in that story) have nowhere to record it.

## Design

### Slot record

One run-scoped store on `NaxRuntime`, replacing `storyAgentTargets`:

```ts
interface LadderSlot {
  readonly target: FallbackTarget; // agent + tier | model
  readonly depth: number;          // ladder index: 0 = configured primary, 1..n = map rungs
}
// key: storyId | tier | agent | role
```

`target` and `depth` are one value because they must always agree; splitting them across
two maps written from two layers is the seam that let #1964's `finalAgent` be returned
and never consumed.

**`depth` is a ladder index, not a swap counter.** A slot that starts at rung 2 because
rungs 0-1 are cooling *is* at depth 2 and does not get a fresh budget from there.
`maxHopsPerStory` becomes the maximum reachable index. The worked example then holds
exactly: implementer A->B is depth 1, autofix B->C is depth 2, cap 2 permits both and
stops there.

Two consequences worth stating explicitly. Every rung counts toward depth, including a
cross-agent one — the ladder is one sequence, so `claude` at index 3 is depth 3. And a
slot already at `depth === maxHopsPerStory` cannot descend further: it declines the swap
exactly as today (`hop-cap-reached`) and the operation follows the existing exhaustion
path.

**Scope decisions:**

- **Role is the family.** No new taxonomy: `implement`, `autofix-implementer`,
  `full-suite-rectify-op` and `rectify` already declare `session: { role: "implementer" }`;
  `write-test` and `autofix-test-writer` already declare `"test-writer"`. The slot key's
  role component is the operation's declared `SessionRole`.
- **Slots are per role; cooldowns are global.** A slot remembers *where I landed*; the
  `CooldownStore` propagates *what is dead*. So `test-writer` does not share the
  implementer's slot, but when the implementer kills native A the test-writer's own slot
  skips A at start and lands on native B regardless. This is what lets reviewers keep a
  deliberate model pin while never dispatching to a dead endpoint.
- **Depth is per slot** — per `(storyId, tier, agent, role)`. Roles cannot starve each
  other, and the bound stays finite and predictable because the slot set is small and
  fixed.
- **A tier escalation resets the ladder and keeps cooldowns.** A new tier is a genuinely
  different endpoint (`models.native.powerful` is not `models.native.balanced`), so the
  slot key already carries the tier and a new tier starts at depth 0. It cannot loop on a
  dead endpoint, because cooldowns are `agent+tier+model` scoped and survive.

### Dispatch flow

1. **Start on the slot.** `callOp` reads the slot and passes both the target and its depth
   into `runWithFallback`. The start hop is `HopKind: "primary"` **carrying that rung's
   `tier`/`model`** — populating the field the type already documents. A failure on native
   B then marks native B, and the next candidate is native C.
2. **Endpoint-truthful cooldown marking.** The endpoint a hop *actually dispatched*
   (`build-hop-callback` has already resolved a concrete `modelDef`) flows back to
   `runWithFallback` and is what gets marked — instead of the tier/model the `HopKind`
   happened to declare, which is `undefined` for a config-default primary. The bare-agent
   key then means only what `failurePolicyFor(...).cooldownScope === "agent"` intends:
   auth failures, missing binaries, faults genuinely shared by every model the agent
   fronts.
3. **Endpoint-aware start check.** `resolveStartAgent` asks about the endpoint the
   operation would dispatch to, not the bare agent name. This requires (2): without it the
   dead-primary skip would stop working, because the primary's failure would carry no
   endpoint identity to match against.

(2) and (3) also close the loose thread noted in #1965's own analysis: `SessionRunHopFn`
is `(agentName, options)` and drops `HopKind`. Carrying the dispatched endpoint back
through that seam is the same edit, so the seam is hardened rather than left as a latent
hazard with no production caller.

### Session lifecycle

The live-handle cache decision moves out of `SessionManager` into
`src/session/endpoint-identity.ts`:

```ts
type Reuse = "reuse" | "close-then-reopen" | "reopen";
function decideReuse(
  live: SessionHandle | undefined,
  desc: SessionDescriptor | undefined,
  opts: OpenSessionRequest,
): Reuse;
```

- `reuse` — same agent, same endpoint (`provider` + `model`; `pricing` and
  `contextWindow` are metadata, not identity), descriptor non-terminal. Today's fast path.
- `close-then-reopen` — a live handle exists but the agent or the endpoint differs.
  `closeSession(liveHandle)` first, then the full open path; the descriptor lands
  `COMPLETED` and the existing terminal-to-`RUNNING` branch picks it up.
- `reopen` — no live handle, or a stale one against a terminal descriptor.

This covers both triggers in one place: to the cache, a same-agent swap and an operation
inheriting a sticky target are the same situation. `close-then-reopen` on an **agent**
change additionally fixes a real leak — a cross-agent swap currently overwrites
`_liveHandles` without closing the previous handle, so an `acp -> native` swap orphans the
acpx process until TTL or teardown. (`native -> acp` orphans nothing, because the native
adapter has no process, which is why the field run did not show it.)

`build-hop-callback` needs no separate close-on-swap step: a swap always differs in agent
or endpoint by construction, since `sameFallbackHop` has excluded identical rungs since
#1970.

### Cross-transport

Verified rather than assumed, in both directions:

- **Routing is by agent name** — `native` selects `NativeAgentAdapter`, every other known
  name selects `AcpAgentAdapter` — gated by `agent.protocol`. A ladder mixing `native` and
  an acpx agent requires `protocol: "hybrid"`.
- **Model application** differs by transport and is sound either way once the session is
  genuinely re-opened: ACP bakes the model into the spawned command
  (`acpx --model <model> <agent>`), native carries `modelDef` on the handle and reads it
  per turn. Neither takes effect on a reused handle, which is why the session fix is the
  whole of it.
- **`resume`** is derived from descriptor existence, so a cross-transport hop is told
  `resume: true`. Benign: ACP treats it as a hint and keys `loadSession` by session name
  *and* agent name; the native adapter ignores the flag.
- **Descriptor handoff** is already correct — `recordAgentHandoff` early-returns when the
  agent is unchanged, so a same-agent swap records nothing.

### Protocol-gate validation

`validateProtocolGate` already answers "given the declared protocol, is this `models`
block reachable?". The same question is extended to `agent.fallback.map`: a rung naming
`native` under `protocol: "acp"`, or an acpx agent under `protocol: "native"`, is a config
error. Today it surfaces only at dispatch time, mid-story, as `AGENT_NOT_FOUND` after the
hop budget has already been spent.

## Out of scope

- **Ladder exhaustion behaviour.** When a slot has descended its whole ladder and still
  fails, the existing `resolveExhaustion` path (wait-and-retry, then exhausted) stays
  as-is. The observed multi-minute loop of revalidating unchanged code is #1968 — a
  rectification pass with zero successful dispatches reporting `completed` — which has its
  own cause.
- **Per-role fallback ladders.** One ladder per agent remains, so a reviewer's first swap
  lands on an implementer-shaped rung. Letting roles declare their own ladder is a config
  surface change and deserves its own issue.
- **Session-name changes.** Names stay `nax-<hash>-<feature>-<story>-<role>`, preserving
  prompt-audit correlation and descriptor identity.

## Verification

#1965 survived a 16,000-test suite because every fallback test stubs the session layer —
the one place the endpoint is dropped is never exercised. The plan closes that hole
specifically.

- **L1 — `endpoint-identity` decision table.** Same endpoint -> `reuse`; differing
  `provider` or `model` -> `close-then-reopen`; differing agent -> `close-then-reopen`;
  terminal descriptor -> `reopen`.
- **L2 — `SessionManager` with a real cache.** Two opens, same name and agent, different
  `modelDef`: the second handle carries the new model and `adapter.closeSession` was
  called once. This test fails against today's code (returns `minimax/MiniMax-M3` where
  `opencode-go/deepseek-v4-flash[high]` was requested) and the cross-agent control passes
  — the failing-before-the-fix test the earlier attempt could not produce, which is why
  that implementer correctly reported BLOCKED.
- **L3 — slot arithmetic.** Ladder index from a real `agent.fallback.map`; cap enforced at
  the index, not the event count; per-role isolation; tier-change reset with cooldowns
  preserved.
- **L4 — composite, and the executable form of the goal.** Extend
  `test/unit/agents/manager-swap-loop.test.ts` to run three operations of one story
  through a **real** `SessionManager`, `AgentManager`, `CooldownStore` and ladder,
  stubbing only adapter dispatch: op 1 fails on native A and lands on native B; op 2
  dispatches native B *with native B's model on the handle*; op 2 fails and lands on
  native C; op 3 dispatches native C. Then the same shape for `native -> claude` and
  `claude -> native`, asserting the prior handle was closed rather than orphaned.
- **L5 — live fallback-probe run.** The only end-to-end proof for the transports: a real
  run with a deliberately dead primary, reading the `model` field on the
  `Agent call started` line after each `Agent swap triggered`. Requires explicit approval
  at launch.

## Implementation constraints

Every file on this path is at or near the file-size ratchet, so each change is paired with
an extraction that pays for it. `scripts/baselines/` must show zero diff on the branch.

| File | Now | Change | How it stays legal |
| --- | --- | --- | --- |
| `src/session/manager.ts` | 679 (grandfathered, frozen) | endpoint-aware cache | Net negative: the inline cache branch collapses to a `decideReuse` switch; logic moves to `session/endpoint-identity.ts` |
| `src/operations/build-hop-callback.ts` | 600 (hard limit) | report the dispatched endpoint | Net negative: lift model resolution (`pinnedModelDef`, `resolveForHop`, the two `modelTier` spreads) into `operations/hop-endpoint.ts`, returning `{ modelDef, modelTier? }` |
| `src/agents/manager.ts` | 596 | slot-aware `nextCandidate`, endpoint-scoped availability | Delegate to `hop-budget.ts` and new `agents/ladder-slot.ts` |
| `src/agents/hop-budget.ts` | 85 | depth-as-index, endpoint-aware `resolveStartAgent` | Room |
| `src/agents/manager-run-fallback.ts` | 332 | start depth in; final depth and endpoint out | Room |
| `src/operations/call-resolvers.ts` | 252 | slot read/write replaces `storyAgentTargets` | Room |
| `src/runtime/index.ts` | 447 | `storyAgentTargets` -> `ladderSlots` | Room |
| `src/config/schemas-protocol-gate.ts` | 104 | ladder rungs vs. protocol gate | Room; same question the file already answers |

New modules: `session/endpoint-identity.ts`, `operations/hop-endpoint.ts`,
`agents/ladder-slot.ts`.

## Compatibility

- Existing `agent.fallback.map` spellings (bare string, `{agent, tier}`,
  `{agent, model}`) are unaffected.
- `maxHopsPerStory` keeps its name and its numeric meaning for the common case (a story
  that starts at the primary and descends). It changes only for a story that *starts*
  below the primary, where it now bounds total ladder depth rather than granting a fresh
  event budget — the behaviour the field run showed to be wrong.
- Session names, descriptor identity and prompt-audit filenames are unchanged.
