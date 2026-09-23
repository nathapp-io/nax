# Full native loop events — design

**Date:** 2026-09-22 · **Status:** PR 1 MERGED · PR 2 MERGED · PR 3 designed (§8, re-scoped
2026-09-23)
**Baseline:** originally written against `main` @ `3459ca6d6`. **PR 1 merged as `f849ca9b7`
(#2186) and moved every cited line**; §6.1 and §5.6 now carry post-extraction homes. Citations
outside those sections still name pre-extraction lines — re-derive before trusting one. **PR 2
merged as `fc4dcfcc9` (#2187)**; §8 is re-derived against it.
**Implements:** phase 3 of the native-coding-agent arc (goal 3)
**Master plan:** `nax-native-coding-agent-master-plan.md` (workspace, not this repo)
**Supersedes in part:** `docs/specs/SPEC-native-loop-events.md` — its "Out of Scope" list
**Branches:** PR 1 `feat/p3-turn-loop-extraction` ✅ merged (`f849ca9b7`) · PR 2
`feat/p3-loop-events-seam` ✅ merged (`fc4dcfcc9`) · PR 3 `feat/p3-transcript-model-identity`
(off `main`)

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

~~Two production consumers ship with P3, and only one of them is a new event: the truncation
migration onto the **existing** `after_tool` (§7), and nax#2150 onto `before_turn` (§8).~~
**Amended 2026-09-23:** **one** production consumer ships with P3 — the truncation migration
onto the **existing** `after_tool` (§7). nax#2150 is not a `before_turn` consumer after all:
it turned out to be unreachable on `main` (§8.1), so **none of the six new events** has a
production consumer. That is the §2.1 ruling applied without exception, not a new decision.

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

At either boundary a rewrite is free. (This paragraph used to cite nax#2150 as "a real bug that
can only be fixed by rewriting there"; §8.1 found it unreachable — amended 2026-09-23.)

**The rule governs both history-rewriting events**, `transform_context` and `before_turn` —
not `transform_context` alone. The compaction half of the boundary belongs to
`transform_context`. **Amended 2026-09-23:** the model-change half is **never computed**.
`before_turn` would have been its home, but cross-model history can never reach a turn (§8.1,
and §8.3 makes that local to the transcript store), so `before_turn`'s `boundary` is always
`false` and its history channel is honoured only where the anchor is undefined (§3.5). The
model-change boundary stays in this section as the reason a rewrite *would* be free, not as a
code path.

### 3.4 The exemption is computed, never claimed

**The dispatcher computes the boundary. A handler may never assert one.** A handler that
could say "trust me, I'm at a boundary" is master-plan D13a's failure mode in a new costume —
an advisory screen the caller can switch off. The dispatcher has both facts at hand: the
compaction step knows it just compacted. (The model comparison was the other half, retired
with the original §8 — see §3.3.)

### 3.5 Where the anchor comes from, and the undefined case

The "cache anchor" is `anchorIndex`, tracked at `turn-loop.ts:325` (`anchorIndex =
messages.length - 1` after each response) and persisted across turns via
`nativeSessionLastUsage` (`:326`). Elements **after** it are new and uncached, so rewriting
them is free; elements up to it are the cached prefix the checker protects.

`anchorIndex` is `undefined` in two situations, and both mean *there is no cached prefix to
protect*: a fresh session that has not completed a round trip, and immediately after a
compaction, which sets it to `undefined` deliberately (`:212-213`, "the anchor described the
pre-compaction array; it is meaningless now").

> **`anchorIndex === undefined` permits a full rewrite.** That is not the permissive-on-
> ignorance failure the retired §8.4 guarded against: an absent anchor is positive knowledge
> that nothing is cached, whereas an absent `model` field was genuine ignorance about whether
> a warm cache exists. Unknown-that-there-is-nothing permits; unknown-whether permits nothing.
> (PR 3's §8.3(c) reads an absent file `model` permissively for a different reason: there the
> permissive branch is a *load*, today's behaviour, not a rewrite.)

### 3.6 A boundary rewrite invalidates the anchor

**Any honoured history rewrite must clear `lastUsage` and `anchorIndex`, exactly as the
compaction path already does at `:212-213`** — and clear the persisted
`nativeSessionLastUsage` entry with them.

This is not optional bookkeeping. `anchorIndex` indexes *into the array that was rewritten*;
after any honoured rewrite of loaded history, the stored index points at a different message,
or past the end. (PR 3's §8.3(d) applies the same reasoning to an *empty* load.) It is read by `estimateContextTokens(messages, lastUsage,
anchorIndex)` at `:161`, which decides whether to compact — so a stale anchor silently
mis-sizes the context and either compacts a small conversation or fails to compact a large
one. The dispatcher clears it, not the handler (§3.4).

### 3.7 What stops

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
`us-003-acs`, and more. Critically they drive the **exported entry point**, not internals. Verified, not assumed:
`turn-loop.ts` has **exactly one export** (`runNativeTurn`, `:52`), and all eleven test files
that import from the module import only that symbol; the remaining three reach it through
`adapter.ts`. There is no internal surface for a test to have coupled itself to.

> **PR 1's entire proof is that all fourteen pass unedited.** If a test needs an edit, the
> refactor has stopped being pure — stop, say so, and re-scope. This converts "did I break
> anything?" from a judgement call into a binary check.

PR 1 contains **zero** new events, zero behaviour change, and zero test edits.

---

## 6. The events

### 6.0 Post-extraction homes (verified on `f849ca9b7`)

PR 1 landed the §5.4 carve-up: `turn-loop.ts` 599 → **290** lines, six new modules, **zero test
edits**. The insertion points are now:

| event | module | anchor |
|---|---|---|
| `before_turn` | `turn-loop.ts` | the seed push, `:52` |
| `transform_context` | `turn-complete-step.ts` | the `request()` wrapper of §6.5 |
| `before_request` | `turn-complete-step.ts` | same wrapper |
| `after_response` | `turn-loop.ts` | the assistant push, `:206` |
| `before_compaction` | `turn-compaction-step.ts` | `runProactiveCompaction:95` and `runOverflowCompaction:143` |
| `before_turn_end` | `turn-loop.ts` | before `buildTurnResult`, `:277` |
| truncation migration (§7) | `turn-tool-batch.ts` | `:190-199` and `:221-224` |

🚨 **`deps.complete` is invoked THREE times, not once** — `turn-complete-step.ts:63` (primary),
`:82` (inside `retryTransportFault`'s `attempt` closure) and `:131` (the post-overflow retry).
The §1 claim that extraction collapses the two `complete` sites into one was about the
*module*, not the call count. See §6.5.

### 6.1 Table

| event | site (after §5) | payload | returns | stop rule |
|---|---|---|---|---|
| `before_turn` | `turn-loop.ts`, at the seed push (`:69` today) | `prompt`, loaded history (readonly), session identity, dispatcher-computed `boundary` (always `false`, §3.3) — **`previousModel`/`currentModel` removed by PR 3 (§8.3)** | `{ seed }`, or a history rewrite **only at a boundary** | Seed-only unless the anchor is undefined (§3.5). Off-boundary history patch rejected + logged. Seed must be a non-empty user-role array. |
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

### 6.5 One `request()` wrapper, because `complete` is called three times

`completeWithRecovery` invokes `deps.complete` at three points (§6.0). All three are genuine
provider requests, and pi's `before_request` is explicitly *per request attempt*. Dispatching
at each call site by hand would be the drift §1 exists to prevent, three ways this time.

**Both events dispatch from one private `request(messages, tools, attempt)` helper inside
`turn-complete-step.ts`, and all three call sites route through it.** The helper is what
increments and reports `attempt`, so the retry closure at `:82` reports attempt 2..n without
the retry machinery knowing an event exists.

### 6.6 `transform_context` patches the WIRE COPY, not the array

**User ruling, 2026-09-22.** In nax, `messages` is both the transcript and the wire payload —
`saveTranscript` persists the same array `deps.complete` receives. pi keeps those separate, so
this question does not arise there.

> An honoured `transform_context` patch shapes **only what `deps.complete` receives**. The
> array `saveTranscript` persists is untouched. The transcript stays the true record of the
> conversation, and the event stays what its name says: transform the context for *this
> request*, not rewrite history.

This is also why the split is right rather than an accident. (It was argued here from the
original §8.2's placement of nax#2150 on `before_turn`; that consumer is retired, §8.1, but the
split stands on its own.)
A handler wanting to rewrite the conversation has `before_turn`; a handler wanting to shape one
request has `transform_context`; neither can do the other's job by mistake.

**The anchor is still cleared when a boundary rewrite is honoured** (§3.6), even though the
persisted array did not change — because the prefix the provider actually saw did. Not clearing
it would size the next compaction decision against an array the model was never sent.

**Consequence for the checker:** it compares the returned array against the array passed *in*,
which is the untransformed one. When no element before the anchor changed, indices align and
the wire copy and the persisted array share their prefix — nothing to invalidate. When
something before the anchor did change, it is a boundary case, where the anchor is being
cleared anyway.

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

## 8. PR 3: the transcript store refuses cross-model history (re-scoped 2026-09-23)

> **The original §8 is retired.** It made nax#2150 the proof consumer of `before_turn`: record
> the model on the transcript, let the dispatcher compute a model-change boundary, and have a
> handler strip the previous model's `thinking` blocks and orphaned `tool_use` from loaded
> history. Its premise, that a fallback swap loads the previous model's transcript, does not
> hold on `main` (§8.1). The alternative that the original intent pointed at, keeping history
> across a swap, was measured and rejected (§8.2). What PR 3 builds instead (§8.3) is smaller,
> and it puts the guarantee in the layer that owns the data.

### 8.1 nax#2150 is unreachable on `main`

Verified on `fc4dcfcc9`:

1. **Every production open goes through `SessionManager.openSession`**:
   `session-run-hop.ts:92`, `build-hop-callback.ts:414,443`, `session-keeper.ts:96`. Native
   `complete()` sends one fresh user message and never touches a transcript (`adapter.ts:187`).
2. **A model change closes the session.** `openSessionImpl` consults `decideReuse`
   (`endpoint-identity.ts:47-48`). If a live handle is cached under the name with a different
   agent or a different endpoint (provider + model), the result is `close-then-reopen`.
3. **The native close removes the transcript from the load path.** `closeNativeSession`
   (`session.ts:197-216`) deletes it after a clean last turn, and renames it to
   `.failed-<stamp>.json` after a failed one (nax#1877). Neither is a name `loadTranscript`
   opens.
4. **A crashed process's leftover is refused by the owner check.** The owner is
   `scopeId ?? callId`, and both are random per process (`cost-aggregator.ts:339`,
   `call.ts:94`).

So the new model always loads `[]`. `decideReuse` landed in `cf8e63fe5` (#1965, 2026-09-10),
before nax#2150's own `d0af01c39` baseline. The issue's chain goes from "same session name,
same owner" straight to "transcript loaded" and skips step 2.

**Proved, not only read.** A throwaway spike drove the real `SessionManager`, native
open/close, `runNativeTurn` and transcript store, faking only the provider's `complete`. It was
deleted and never committed.

| Scenario (same name, same owner) | Model B's first request | Model A's transcript |
|---|---|---|
| A's turn succeeded, handle live, B opens | 1 message (its prompt), 0 thinking | deleted |
| A's turn failed mid tool batch, B opens | 1 message, 0 thinking | renamed `.failed-*` |
| **Control:** A reopens on the same endpoint | 3 messages, 1 thinking block | reused, replayed |

The control is what makes the first two rows mean something: the harness does see a replay
when one happens.

### 8.2 Carrying history across a swap: measured, not built

The alternative to discarding is to **keep** history across a swap and make it safe:
- nax-ai stamps each replayed assistant message with the model that actually wrote it, instead
  of the current one;
- pi-ai's `transformMessages` then does the cross-model cleanup at the wire (downgrading or
  dropping thinking, stripping signatures, normalising tool-call ids);
- the session layer stops closing and discarding on a native-to-native change.

This was measured against the local run ledgers: native runs from 2026-09-05 to 2026-09-22,
32 in-session model swaps.

- **27 were one provider's quota 429s**, and 18 of those came at ≤1 round trip, with nothing to
  carry. Once a plan's quota runs out, every later session fails on its first request.
- **3 were `fail-spin`.** There the transcript *is* the failure, so carrying it spreads the
  failure.
- **Where 20 or more round trips were lost (n = 10)**, the new model reached its first write in
  a median of 18 round trips, for $0.007-0.057 each. That is no slower than a normal fresh
  start (median 29.5).
- **Carrying would cost more.** It would put an estimated 166k-278k uncached tokens on the new
  provider's first request, more than the whole re-exploration's 66k-122k uncached input.

**Not built.** Re-open this only if the swap mix changes, meaning swaps start landing after
real work on healthy transcripts. Re-measure first.

### 8.3 What PR 3 builds

**Why build anything if the bug is unreachable.** "A model change on a session name never
replays history" holds today only because three decisions in two layers happen to combine:
#1965 in nax's `src/session/`, and #1838/#1877 in the native close. Nothing names the
guarantee, so a change to `decideReuse` could reopen nax#2150 silently.

Master-plan D8 makes this sharper. P6 extracts the native session loop and the transcript store
into `nax-coding`, while `SessionManager` stays nax-side. After that extraction the package
would not carry the guarantee at all.

So **the transcript store enforces it itself**, the same way it already enforces ownership
(nax#1877).

**(a) `TranscriptFile` records the model:** `{ owner?, model?, savedAt, messages }`.

**(b) Model identity is `parseModelSpec(handle.modelDef.model).model`.** That is the native
`provider/model` id with the reasoning-effort suffix stripped. The format is documented at
`models.ts:49`; the separate `provider` field is ignored on the native path (`adapter.ts:171`).
- **Effort is stripped** because a thinking signature binds to the model, not to the effort.
  pi-ai's `isSameModel` compares `provider/api/model` for the same reason.
- **`parseModelSpec`, not `parseNativeModel`**, because it never throws (`model-spec.ts:33`).
  That matters: tests drive `runNativeTurn` directly with arbitrary `modelDef`s.
- **Computed in `turn-loop.ts` from `handle.modelDef`.** A handle with no `modelDef` declares no
  model.

**(c) The load rule, applied beside the owner check:**

| Reader's model | File's model | Result |
|---|---|---|
| none declared | anything | read (no claim, as with owner) |
| X | X | read |
| X | Y, not X | **`[]`**: a new conversation, debug-logged like an owner mismatch |
| X | absent | read |

**An absent file model reads.** This deliberately differs from the owner check, which drops. It
is safe because every native production turn has a parseable model before the loop runs:
`adapter.ts:251` parses it and throws if it can't. So every file this code writes carries a
model, and an absent one can only be a file written before this change. Those never survive
into a new process: the owner check refuses them (§8.1 step 4).

Dropping would therefore buy nothing in production, and it would break a legitimate test
pattern: `adapter-complete-rates.test.ts:430` seeds a transcript with no model, then turns with
a handle that has a `modelDef`.

This does not contradict the retired §8.4 ("unknown does not grant"). There the permissive
branch was a history *rewrite*. Here the permissive branch is today's behaviour, loading, so
unknown keeps today's behaviour.

**(d) An empty load discards the persisted anchor.** `nativeSessionLastUsage` survives across
the turns of a live session, and its `anchorIndex` indexes the history it was measured against
(§3.6). If the store returns `[]` while an anchor is held, `turn-loop.ts:108-110` would hand
`estimateContextTokens` an index into an empty array.

Rule: **when the loaded history is empty, `runNativeTurn` ignores the persisted anchor and
deletes the entry.** That is correct whatever emptied the history, because empty history has
no cached prefix. It also covers the owner-mismatch path, which has the same latent shape. On a
fresh session, the history is empty and no anchor exists, so the rule is a no-op.

**(e) Signature.** Owner and model are one concept, "who may resume this file", and they are
compared in one place. They travel together as `TranscriptIdentity = { owner?: string; model?:
string }`:

```ts
loadTranscript(dir, sessionName, identity?)
saveTranscript(dir, sessionName, messages, identity?)
```

This replaces the positional `owner`, so `saveTranscript` stays at four positional parameters
instead of growing to five. Callers are migrated mechanically: 3 `src/` sites in
`turn-loop.ts`, and the 20 test call sites that pass an owner string (counted 2026-09-23:
`transcript-store.test.ts` 13, `session-lifecycle.test.ts` 5, `turn-loop-compaction.test.ts`
1, `transcript-sweep.test.ts` 1). Call sites that pass no owner compile unchanged.

**(f) The dead payload fields are removed.** `BeforeTurnPayload.previousModel`/`currentModel`
(`loop-events/types.ts:93-95`) were reserved for the original §8. They can never be populated
now, because cross-model history never reaches `before_turn`. §12's rule against advertising a
channel that writes nowhere, applied there to `systemPrompt`, applies here too.

Remove the fields and their "PR 3" comments: `turn-loop.ts:112-118`,
`turn-complete-step.ts:58-64` and `:133-134`, `types.ts:93`, and the comment at
`turn-lifecycle.test.ts:101`. That test's `not.toHaveProperty` assertions stay; they now pin
the removal.

**`boundary` on `BeforeTurnPayload` stays.** It is truthful (always `false`, §3.3), it is part
of the history-event contract `transform_context` shares, and it is the input
`applyHistoryPatch` reads.

**(g) Not changed:** `decideReuse`, the close semantics, and nax-ai. nax-ai's `toPiMessages`
stamps every replayed assistant message with the *current* model (`pi-client.js:87-91`), which
defeats pi-ai's `isSameModel` gate. With §8.1 and (c) in place that is latent with nil blast
radius, so it is recorded in the PR body, not filed as a new issue.

### 8.4 What stops

A cross-model load stops the **history**, never the turn. The turn proceeds as a new
conversation, which is exactly what the close path produces today. A false rejection costs one
re-exploration, which §8.2 measured at under $0.06.

### 8.5 nax#2150

Closed as not reproducible on `main`, citing §8.1's evidence and PR 3's guard. The comment is
public, so it is posted only after the user approves it.


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

~~**PR 3 (#2150):** same model → rewrite rejected; changed model → rewrite honoured; absent
`model` field → rewrite rejected; an honoured rewrite clears the anchor.~~ Retired with the
original §8.

**PR 3 (re-scoped, §8.3):**

- **Store, every row of §8.3(c)'s table**, plus the owner/model interaction in both
  directions: an owner mismatch still returns `[]` when the models agree, and a model mismatch
  returns `[]` when the owners agree. Save writes `model` when given and omits the key when not.
- **Turn level, driving `runNativeTurn`** (§9.1): history saved by a turn under model A, then
  a turn on a handle with model B → B's first `complete` receives **only the seed**, and
  `before_turn` receives `history: []`. The control: a handle whose model differs from A's
  **only by the effort suffix** gets the history replayed — without it, a store that rejects
  every load would pass the rejection test.
- **The anchor, read directly** (§8.3(d)): with a persisted `nativeSessionLastUsage` entry and
  a load that comes back empty, the entry is discarded — assert on the entry after the turn,
  not on the messages. A stale anchor is invisible in the message array and only surfaces as a
  mis-sized compaction decision one turn later.
- **One composite guard through the real `SessionManager`** (the §8.1 spike, rebuilt on the
  shared helpers): a model change on a session name yields a fresh conversation. It proves the
  guarantee end to end through production wiring, and it keeps passing if either layer alone
  regresses — which is the point of having two.
- **Removal pinned:** `turn-lifecycle.test.ts:102-103`'s `not.toHaveProperty` assertions stay
  and now pin §8.3(f).

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
| 1 | `feat/p3-turn-loop-extraction` | ✅ **MERGED** `f849ca9b7` (#2186). turn-loop.ts 599 → 290, six modules, **zero test edits** — the proof obligation held. |
| 2 | `feat/p3-loop-events-seam` | §4 registry, §6 events, §3 checker, §6.3 widened `complete`, §6.5 request wrapper, §7 truncation migration |
| 3 | `feat/p3-transcript-model-identity` (off `main`) | §8.3 — `model` on `TranscriptFile` + the store's load rule, `TranscriptIdentity`, the empty-load anchor rule, removal of `previousModel`/`currentModel`. ~~The `before_turn` handler~~ retired (§8.1). |

A pure-refactor diff is reviewable by inspection; a diff that both moves 400 lines and adds
six events is not. Every real finding on P1's PR #2184 was found by a reviewer, not by the
suite — including D13a, where a "fail open" correction silently became "abandon the screen".

Splitting PR 3 out is also what kept both of the user's §5 rulings compatible: #2150 was the
proof consumer, *and* the extraction stayed pure. If #2150 turned out to need more than the
seam offers, PRs 1 and 2 would already be merged rather than blocked behind a bug fix — which
is what happened, in a direction nobody predicted: #2150 needed *less* than the seam, because
it was unreachable (§8.1).

---

## 11. Risks

1. **PR 1 is the highest-regret item in P3.** It touches the most load-bearing 600 lines in
   the native path and its payoff is structural rather than visible. Mitigated by §5.5's
   no-test-edits rule.
2. **Widening `TurnDeps.complete`** (§6.3) touches the adapter/session boundary P6 cares
   about with no consumer asking yet. Mitigated by keeping the bag minimal and additive.
3. **Six events, zero production consumers** (amended 2026-09-23 from "at most two"; §2.1). Accepted by the §2.1 ruling; restated in
   the ADR so a later reader does not read dead seams as oversight.
4. **`before_turn_end`'s `followUp`** is the only event that can spend money unprompted.
   §6.4's stop rules are what keep it from becoming a cost incident.
5. **PR 3's signature change** (§8.3(e)) touches 20 test call sites. Mechanical — the owner
   string becomes `{ owner }` — but a reviewer should see it named here rather than discover
   it in the diff. Call sites passing no owner are untouched.
6. **The guarantee now lives in two layers** (`decideReuse` and the store). If a future
   design wants cross-model continuity (§8.2), **both** must change, and §8.2's measurement
   must be redone first.

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
