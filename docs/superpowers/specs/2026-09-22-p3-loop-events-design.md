# Full native loop events — design

**Date:** 2026-09-22 · **Status:** designed (no implementation started)
**Baseline:** `main` @ `3459ca6d6` (PR #2185 merge) — every citation verified at that commit
**Implements:** phase 3 of the native-coding-agent arc (goal 3)
**Master plan:** `nax-native-coding-agent-master-plan.md` (workspace, not this repo)
**Supersedes in part:** `docs/specs/SPEC-native-loop-events.md` — its "Out of Scope" list
**Branches:** PR 1 `feat/p3-turn-loop-extraction` (this spec lives here) · PR 2 and PR 3 take
their own branches off PR 1

---

## 1. Problem

`src/agents/native/session/loop-events.ts` ships exactly two events — `before_tool` and
`after_tool` — registered synchronously and dispatched from `turn-loop.ts:411,480,511`. Nine
of pi's eleven `HookMap` events are named as out of scope in
`docs/specs/SPEC-native-loop-events.md:291-301`.

Master-plan goal 3 asks for the full lifecycle-event set. Two things make that more than a
box-ticking exercise:

**The synchronous dispatcher has already cost something concrete.** The seam's own canonical
consumer — the model-facing truncation policy that US-002 was justified by — **could not be
registered as an `after_tool` handler**. `truncation-handler.ts:4-14` says so outright: the
dispatcher is synchronous while applying the policy has to await the spill write, and AC8's
fail-open contract means the marker may only name the spill file when that write actually
succeeded, so the write cannot be fired and forgotten. It sits as a hardcoded `await` at
`turn-loop.ts:483` beside the dispatcher rather than inside it.

**Four of the six new events have multiple insertion points in one 599-line function.**
`transform_context` and `before_request` would each need dispatching at two `deps.complete`
sites (`:229`, `:303`); `before_compaction` at two more (`:161` proactive, `:276` reactive);
`after_response` at `:350`, reached from three recovery paths. This is nax#2151's "six
`after_tool` push sites" argument one level up, and it is how the four truncators in that
issue drifted apart in the first place.

## 2. Goal

The six events nax can express, async-capable, each with one dispatch site, and each
write-capable event carrying a stop rule enforced by the dispatcher rather than by handler
authors' discipline.

**Built:** `before_turn`, `transform_context`, `before_request`, `after_response`,
`before_compaction`, `before_turn_end`.

**Never** (unchanged from master-plan D6): `before_payload` — the payload is built inside
nax-ai, behind the boundary `scripts/check-nax-ai-imports.ts` enforces; `before_drive` and
`before_navigation` — no nax analogue, there is no branch navigation.

### 2.1 Scope ruling: the full set, not consumer-driven

User ruling, 2026-09-22: build the full set as goal 3 states it, rather than only the events
with a consumer today. The consequence is accepted and recorded here so a later reader does
not mistake it for oversight: **most of these events ship with zero production consumers**,
proven by test handlers. pi-gap §9.5's warning stands unretracted — "a seam is not a policy;
adding eleven events saves zero tokens by itself". P3 buys expressiveness, not tokens.

Two production consumers ship with P3, and only one of them is a new event: the truncation
migration onto the **existing** `after_tool` (§7), and nax#2150 onto `before_turn` (§8).
`transform_context`, `before_request`, `after_response`, `before_compaction` and
`before_turn_end` ship with **no** production consumer.

### 2.2 Already done — do not rebuild

Master-plan D6 lists "migrate spin breaker / invalid-call repair / tool-audit to registered
handlers where it simplifies". Verified on `3459ca6d6`:

- The spin breaker and invalid-call repair **are already registered handlers**
  (`loop-handlers.ts:58-59`). Nothing to migrate.
- `tool-audit` lives in `src/tools/`, not the session loop. It is not a loop-event concern.
- The pi-gap §3/§8 result-shaping items are shipped and wired (`src/tools/truncate.ts`,
  `truncation-handler.ts`, `turn-loop.ts:483,512`). P3 is **events-only**; it does not
  rebuild result shaping, it only moves where the existing policy is invoked from (§7).

---

## 3. The cache-boundary rule

This is the spine of the design, and the reason `transform_context` is safe to build at all.

### 3.1 The hazard

Measured prompt-cache hit rate on the native path is 96.7%, against a 200k+ token prefix with
100-500 uncached tokens per round trip. Anthropic-style caching is **prefix-matched**: rewrite
anything early in the array and every downstream turn re-bills at input rather than cacheRead
— roughly 5x more expensive. `transform_context` is the one event that can do this, which is
why `SPEC-native-loop-events.md:295-297` excluded it by design rather than by omission.

### 3.2 The rule

Master-plan D6 proposed putting the contract "in the event's docblock and the ADR, not in
handler authors' heads". **User ruling, 2026-09-22: enforce it mechanically in the
dispatcher instead.**

> A history-rewriting patch is honoured **only when the request crosses a cache boundary**.
> Otherwise the returned array must be element-identical, **by reference**, to the input up
> to the cache anchor. A patch violating this is **rejected, the original kept, and the
> violation logged at warn**.

Reference identity, not deep equality: it is O(n) pointer compares over an array nax already
holds, and it is the correct test — a handler that rebuilds an equal-valued message object
has still broken the provider's cache, because the wire payload is what matters and a
"equal" rebuild is free to differ in key order or in fields the comparison skips.

### 3.3 Why a boundary rule and not a blanket ban

Prefix stability is not absolute. It is a property of `(model, prefix)`. Two situations
destroy the cache on their own, before any handler runs:

- **a compaction** — which is why pi resets the boundary (`transcript.ts:47-56`) rather than
  editing history in place;
- **a model change** — the new model has no cached prefix to preserve, so rewriting history
  at that moment costs exactly nothing.

At either boundary a rewrite is free, and nax#2150 (§8) is a real bug that can only be fixed
by rewriting there.

**The rule governs both history-rewriting events**, `transform_context` and `before_turn` —
not `transform_context` alone. §8 places nax#2150's handler on `before_turn`, so the model-change
half of the boundary is exercised there; the compaction half belongs to `transform_context`,
which ships with no production consumer (§2.1). A blanket ban would have made the seam useless
for the one real bug it can fix.

### 3.4 The exemption is computed, never claimed

**The dispatcher computes the boundary. A handler may never assert one.** A handler that
could say "trust me, I'm at a boundary" is master-plan D13a's failure mode in a new costume —
an advisory screen the caller can switch off. The dispatcher has both facts at hand: the
compaction step knows it just compacted, and the model comparison is §8's prerequisite.

### 3.5 What stops

Per the master plan's §5 standing trap, every rule in this spec names what stops. Here: **the
patch stops.** The turn continues on the unpatched array. A handler defect degrades to a warn
line, never to a failed story — the same posture as invariant 3 (a throwing handler is logged
and skipped), extended from crashes to semantic abuse.

---

## 4. Registry shape

### 4.1 Naming: `before_turn`, not `before_run`

pi's `before_run` fires "once, as a run starts". Its nax analogue is the entry to
`runNativeTurn`, which is **one turn** — one prompt, looping until the model stops calling
tools — invoked per prompt from `adapter.ts:307`. `session.ts:103` already speaks of "across
`runNativeTurn` calls — a fix round that opens a new turn on the ...".

A nax **run** (`nax run`) contains many stories, each containing many `runNativeTurn` calls,
and `src/hooks/` already fires genuine run-level events (`on-start`, `on-complete`). Shipping
a loop event called `before_run` into that vocabulary is the foot-gun ADR-030's D11 avoided
when it renamed the `unrestricted` *mode* away from the `unrestricted` *profile*.

**Decision: `before_turn` and `before_turn_end`.** The pi correspondence is stated in the
docblock. The other four keep pi's names; none of them collide.

### 4.2 Async-capable dispatch, and the rejection trap

Handlers return `T | Promise<T>`. The dispatcher awaits each in the existing serial `for`
loop, preserving registration-order chaining.

**The trap that must be pinned by a test:** invariant 3's current `try/catch` catches a
**throw**. It will *not* catch a **rejected promise** unless the await sits inside the `try`.
A handler returning `Promise.reject(...)` must be logged-and-skipped identically to one that
throws. This is master-plan §5's "a test double that cannot fail the way production fails"
trap in its purest form, so **every event's suite carries both failure modes**, not one.

### 4.3 A typed event map, not sixteen methods

Today's surface is a method pair per event (`registerBeforeTool` / `beforeTool`). Eight
events that way is sixteen methods, and an interface every future event must edit.

Instead: `register<E extends LoopEvent>(event: E, handler: HandlerOf<E>)` and
`dispatch<E>(event, payload)`, keyed by an event-map type that carries each event's payload
and patch types. Full type safety at each registration, one registration point, and the two
existing events' call sites change mechanically.

### 4.4 Empty-registry fast path is load-bearing

`transform_context` fires before **every** provider request, against an array that is 200k+
tokens at steady state. If dispatch clones that array to hand it to a chain that is empty —
which it always is today and will be for most runs — P3 makes every request allocate a full
message-array copy for nothing.

**Dispatch returns the input by reference when no handler is registered for that event**, and
§3's checker runs only when a handler actually returned a patch. This is a correctness-adjacent
requirement, not an optimisation: the whole point of P3 is not to regress the token economy it
exists to serve.

### 4.5 File layout

`loop-events.ts` is 166 lines carrying two events, with docblocks that are doing real work —
they are where the four invariants live. Eight events in one file lands well past the 600-line
`src/` gate, which §5 of the master plan states is **not grandfathered for this work**.

```
loop-events/types.ts           event map, payloads, patches
loop-events/registry.ts        dispatcher + the four invariants + async dispatch
loop-events/cache-boundary.ts  §3's checker
loop-events/index.ts           barrel
```

The existing docblocks move rather than shrink.

### 4.6 Handler lifetime: extend the existing pattern

`loop-handlers.ts:44-51` already solves this with a `WeakMap<LoopEventRegistry, State>`: a
second `registerBuiltinLoopHandlers` call for the same registry **repoints** per-turn state
instead of stacking a second handler pair. Verified this is not a latent accumulation defect
— the repoint is correct, and `turn-loop.ts:120` constructs a fresh registry per turn unless
a caller injects one.

The new turn-scoped events **use this same pattern**. P3 does not introduce a second lifetime
scheme.

### 4.7 Invariants carried over unchanged

From `loop-events.ts:11-26`, all four still hold, now across eight events:

1. Results are partial patches, never mutations. No handler receives a mutable message array.
2. Handlers chain in registration order, each seeing the previous one's output.
3. A throwing handler is logged at warn and skipped — extended to rejections per §4.2.
4. No handler may rewrite history — now enforced mechanically per §3, rather than by the
   structural accident that both existing events happen to be safe by construction.

---

## 5. The extraction (PR 1)

### 5.1 Why, beyond the line gate

`turn-loop.ts` is **599/600**. That alone forces an extraction before any P3 loop change. But
the better reason is §1's: the extraction is what gives each new event **one** dispatch site
instead of two or three.

| event | sites today | sites after |
|---|---|---|
| `transform_context` | `:229`, `:303` | 1 (`turn-complete-step.ts`) |
| `before_request` | `:229`, `:303` | 1 (same) |
| `before_compaction` | `:161`, `:276` | 1 (`turn-compaction-step.ts`) |
| `after_response` | `:350`, via 3 paths | 1 (`turn-loop.ts`) |

### 5.2 The obstacle, stated plainly

Roughly seventeen mutable locals are threaded through the single `while (true)`:
`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUsd`,
`rateTotals`, `roundTrips`, `output`, `messages`, `lastUsage`, `anchorIndex`,
`completedNormally`, `timedOut`, `spinStopped`, `spinWarned`, `interactions`,
`codingToolsCalled`. Every candidate extraction reads and writes several. This is why the
file is one function, and any plan that says "just extract the tool loop" without addressing
it is hand-waving.

### 5.3 The unlock

Six of those seventeen — the usage/cost/rate counters — are accumulated by an **identical
10-line block that already appears three times**: `:192-201` (proactive compaction),
`:282-291` (reactive overflow), `:307-316` (round trip). Collapsing it into a
`TurnAccumulator` with one `add(usage, rates, costUsd)` removes two of the three copies *and*
removes six variables from every extracted signature. After that the remaining clusters are
narrow enough to pass explicitly.

The `deps.onActivity({kind: "usage", ...})` beat that follows each copy is **near**-identical,
not identical: the round-trip one additionally carries `roundTrip` (`:345-348`). The
accumulator therefore exposes the beat as a separate call rather than folding it into `add`,
so the third site keeps its extra field instead of the extraction quietly dropping it.

### 5.4 Carve-up

Sizes are estimates.

| module | ~lines | contents |
|---|---|---|
| `turn-accumulator.ts` | 70 | the six counters, the 3x duplication collapsed, the `onActivity` usage beat |
| `turn-compaction-step.ts` | 130 | proactive compaction **and** reactive overflow recovery — both `before_compaction` sites |
| `turn-complete-step.ts` | 90 | `deps.complete` + transport retry + overflow fallback; sole home of `transform_context` and `before_request` |
| `turn-tool-batch.ts` | 200 | the `for (const [callIndex, call] of res.toolCalls.entries())` body |
| `turn-ask-human.ts` | 60 | the `ASK_HUMAN_TOOL_NAME` branch — self-contained, fires no tool events by design |
| `turn-result.ts` | 60 | `TurnResult` assembly and the two tail warnings |

`turn-loop.ts` lands at roughly 200-250 lines: setup, the `while`, and orchestration between
steps.

### 5.5 Proof obligation

**Fourteen test files exercise `runNativeTurn`**, roughly 150 KB of them — `turn-loop.test.ts`,
`turn-loop-compaction`, `turn-loop-transport-retry`, `turn-loop-usage`, `turn-loop-seam`,
`turn-loop-seam-regressions`, `session-lifetime-spin`, `native-truncation-chokepoint`,
`us-003-acs`, and more. Critically they drive the **exported entry point**, not internals.

> **PR 1's entire proof is that all fourteen pass unedited.** If a test needs an edit, the
> refactor has stopped being pure — stop, say so, and re-scope. This converts "did I break
> anything?" from a judgement call into a binary check.

PR 1 contains **zero** new events, zero behaviour change, and zero test edits.

---

## 6. The events

### 6.1 Table

| event | site (after §5) | payload | returns | stop rule |
|---|---|---|---|---|
| `before_turn` | `turn-loop.ts`, at the seed push (`:69` today) | `prompt`, loaded history (readonly), session identity, `previousModel`/`currentModel` | `{ seed }`, or a history rewrite **only at a boundary** | Seed-only unless the dispatcher reports a model-change boundary (§8). Off-boundary history patch rejected + logged. Seed must be a non-empty user-role array. |
| `transform_context` | `turn-complete-step.ts` | `messages`, `tools`, `model`, dispatcher-computed `boundary` | `{ messages }` | §3's checker. Patch rejected, original kept, warn. |
| `before_request` | `turn-complete-step.ts` | `model`, `roundTrip`, `attempt`, the per-call options bag (§6.3) | `{ options }` patch | Additive patch only; identity fields (`callId`, `sessionName`) are surfaced readonly and not patchable. |
| `after_response` | `turn-loop.ts`, the assistant push (`:350`) | `text`, `toolCalls`, `thinking`, `usage` (readonly), `roundTrip` | `{ text, toolCalls, thinking }` | **`usage` and `costUsd` are surfaced but NOT patchable** — the same rule as `denied` on `after_tool`. Billing truth is not a handler's to rewrite. Otherwise safe by construction: shapes the message before it enters the array. |
| `before_compaction` | `turn-compaction-step.ts` | `reason: "proactive" \| "overflow"`, `plan`, pre-compaction token estimate | `{ decline }` or `{ summary }` | **`decline` honoured when `proactive`, IGNORED and logged when `overflow`.** |
| `before_turn_end` | `turn-result.ts`, before the final `saveTranscript` | `messages`, draft result, `roundTrips` | `{ followUp }` — re-enters the loop with another user turn | Capped count per turn, each injection ledgered as its own round trip; **no followUp when the turn ended by a stop**. |

### 6.2 Why `before_compaction`'s decline is ignored at overflow

The reactive branch (`turn-loop.ts:275-303`) runs **after** `deps.complete` has already thrown
a context-overflow error. There is no un-compacted path left: declining leaves the turn with a
request that cannot be sent and kills the story. The proactive branch (`:155-224`) runs before
any request, where declining simply means "send it uncompacted", which is a legitimate choice.

What stops is the **signal**, not the compaction.

### 6.3 `before_request` and the widened `complete`

`TurnDeps.complete(messages, tools)` (`turn-types.ts:54-57`) takes two arguments and **no
options bag**. Model, thinking level and timeout are bound in the adapter's closure *above*
`runNativeTurn` (`adapter.ts:307`), outside the loop. A `before_request` handler at this seam
can observe, but has no target to write to — the same shape as `before_payload` being
unreachable, discovered one layer lower down.

**User ruling, 2026-09-22: widen `TurnDeps.complete` to carry a per-call options bag**, so
`before_request` reaches real parity. It separately unlocks per-round-trip changes such as
dropping `thinking` on a retry.

**Constraint recorded at ruling time:** this widens the adapter/session boundary that P6's
extraction cares about, with no consumer asking for it yet. Keep the bag **minimal and
explicitly additive**, so P6 inherits one extra optional parameter rather than a new concept.
The bag is optional; every existing caller and test fake compiles unchanged.

### 6.4 Why `before_turn_end` may not resurrect a stopped turn

`followUp` is the only event that can spend money on its own. Three turn endings are **stops**,
not completions: `spinStopped` (nax#2120), `invalidCallBudget.exceeded` (nax#2047), and
`timedOut`. Letting a handler inject another turn after one of them re-opens the exact loops
those breakers exist to close, through the back door.

The dispatcher therefore does not fire `before_turn_end`'s followUp channel at all when the
turn ended by a stop, and caps injections per turn regardless.

---

## 7. Truncation migrates into the seam (PR 2)

`truncateNativeToolResult` moves from its hardcoded call sites (`turn-loop.ts:483`, `:512`)
into a registered `after_tool` handler, and `truncation-handler.ts:4-14`'s documented
exception — "WHY THIS IS NOT A REGISTERED `after_tool` HANDLER, despite the seam being the
right place for it conceptually" — is deleted, because §4.2's async dispatch removes the
reason.

Two properties must survive the move, both pinned by the existing `us-003-acs` and
`native-truncation-chokepoint` suites:

- **AC8's fail-open contract**: the marker may name the spill file only when the write
  succeeded. This is why the dispatcher must *await* the handler rather than fire-and-forget.
- **The nudge reserve**: `turn-loop.ts:484-489` passes `reserveBytes` so a nudge's bytes are
  spent out of the result's budget rather than added after the ceiling. The handler payload
  must carry the nudge text, or the reserve is silently lost.

Ordering: truncation registers **last** among `after_tool` handlers, so it shapes whatever
earlier handlers produced — which is what the current hardcoded position after
`loopEvents.afterTool(...)` already means.

---

## 8. nax#2150 as the proof consumer (PR 3)

### 8.1 The bug

A fallback model swap re-opens the same session name with the same transcript owner, so the
new model is replayed the previous model's `thinking` blocks verbatim. A `thinkingSignature`
from one provider is meaningless to another: depending on the provider this is silent quality
degradation, a wasted-token replay, or a hard 400. Measured exposure: **49 of 201 native
story-stages used more than one model.** Orphaned `tool_use` blocks have the same shape when
a swap happens mid-batch.

### 8.2 It belongs on `before_turn`, not `transform_context`

The swap happens **above** `runNativeTurn`: `completeOptions` is built at `call.ts:125` and
the retry/swap loop runs at `:150-153`, calling `completeAsWithFallback`, at the operation
level. (nax#2150 cites `:112` and `:138-140` against its own `d0af01c39` baseline; the file
has drifted, the structure has not.) Within one `runNativeTurn`
invocation the model is constant. A swap re-enters `runNativeTurn` on the same session name,
loading a transcript the *previous* model wrote.

So the model-change boundary is a **turn-start** fact, and `before_turn` is its event.

### 8.3 The prerequisite: the transcript does not record the model

`TranscriptFile` is `{ owner?, savedAt, messages }` (`transcript-store.ts:31-34`). **Nothing
stores which model wrote those messages**, so "has the model changed since this history was
written?" is currently undecidable — which means nax#2150 cannot be fixed by a loop event
alone, on either seam.

PR 3 adds `model` to `TranscriptFile`, writes it on save, reads it on load, and hands
`before_turn` both `previousModel` and `currentModel` so the **dispatcher** computes the
boundary (§3.4 — never the handler).

### 8.4 Backward compatibility, with a stated stop

An existing transcript has no `model` field, so `previousModel` is `undefined`.

> **Unknown does NOT grant the exemption.** No history rewrite, cache preserved, the handler
> simply does not fire on the first turn after upgrade. The *exemption* stops, not the turn.

Self-healing: the next save records the model, and every subsequent turn can decide.

### 8.5 What the handler does at a boundary

Strip the previous model's `thinking` blocks from loaded history, and drop any `tool_use`
left without a matching result. Prior art is `@earendil-works/pi-ai`'s
`packages/ai/src/api/transform-messages.ts:93-125`, which nax already depends on at the wire
layer but does not reach.

---

## 9. Testing

Each PR has a different proof obligation.

**PR 1 (extraction):** fourteen existing test files pass **unedited** (§5.5). Nothing else.

**PR 2 (seam)**, per event:

- a registered handler fires at the right point, with the right payload;
- a **throwing** handler and a **rejecting** handler are each logged-and-skipped (§4.2);
- chaining order — handler 2 sees handler 1's output;
- the empty-registry fast path returns the input **by reference**;
- each stop rule from §6.1, asserted on the composite case, not the happy path.

For §3's checker specifically: a handler that rewrites the prefix off-boundary has its patch
rejected **and the original preserved**. Asserting the rejection alone would pass an
implementation that drops the messages entirely.

**PR 3 (#2150):** same model → rewrite rejected; changed model → rewrite honoured; **absent
`model` field → rewrite rejected** (§8.4).

### 9.1 The test-double rule bites hardest on the checker

Master-plan §5: *"A test double that cannot fail the way production fails will hide a
critical."* Here it is exact:

- a fake handing the dispatcher **freshly-constructed message objects** each call makes every
  patch look like a prefix rewrite — reference identity always fails;
- a fake reusing **one frozen array** makes every patch look clean.

Both are green suites over a broken checker. The doubles must reproduce the real array's
identity semantics, which means driving `runNativeTurn` rather than the dispatcher in
isolation for at least the boundary cases.

---

## 10. Sequencing

| PR | branch | contents |
|---|---|---|
| 1 | `feat/p3-turn-loop-extraction` | §5 only. Zero new events, zero behaviour change, zero test edits. This spec. |
| 2 | own branch off PR 1 | §4 registry, §6 events, §3 checker, §6.3 widened `complete`, §7 truncation migration |
| 3 | own branch off PR 2 | §8 — `model` on `TranscriptFile` and the `before_turn` handler |

A pure-refactor diff is reviewable by inspection; a diff that both moves 400 lines and adds
six events is not. Every real finding on P1's PR #2184 was found by a reviewer, not by the
suite — including D13a, where a "fail open" correction silently became "abandon the screen".

Splitting PR 3 out is also what keeps both of the user's §5 rulings compatible: #2150 is the
proof consumer, *and* the extraction stays pure. If #2150 turns out to need more than the seam
offers, PRs 1 and 2 are already merged rather than blocked behind a bug fix.

---

## 11. Risks

1. **PR 1 is the highest-regret item in P3.** It touches the most load-bearing 600 lines in
   the native path and its payoff is structural rather than visible. Mitigated by §5.5's
   no-test-edits rule.
2. **Widening `TurnDeps.complete`** (§6.3) touches the adapter/session boundary P6 cares
   about with no consumer asking yet. Mitigated by keeping the bag minimal and additive.
3. **Six events, at most two production consumers.** Accepted by the §2.1 ruling; restated in
   the ADR so a later reader does not read dead seams as oversight.
4. **`before_turn_end`'s `followUp`** is the only event that can spend money unprompted.
   §6.4's stop rules are what keep it from becoming a cost incident.

---

## 12. Out of scope

- `before_payload`, `before_drive`, `before_navigation` (§2) — permanently, with reasons.
- `transform_context` returning a `systemPrompt` patch. pi's does; nax has no system role
  yet, which is pi-gap §9.4's gap 4 — real section-diffing "needs the system role to exist
  first". Advertising a channel that writes nowhere is §6.3's problem a second time, so it
  stays off the type until the system role exists.
- Extending `src/hooks/` — different lifecycle, different cadence, a 5s shell-out per tool
  call at a median 45 round trips per session.
- Result-shaping policy changes. §2.2: shipped and wired. P3 moves where truncation is
  invoked from (§7); it does not change what it does.
- nax#2151's remaining items (per-line caps, the four drifted truncators in `read.ts`,
  `grep.ts`, `git.ts`, `bash.ts`). The seam makes a single policy point possible; applying it
  to the typed tools is separate work.
- Any change to compaction thresholds or configured `contextWindow`.
- Closing nax#2175 (P2's issue) — tracked on the master plan, not here.
