# ADR-028: Native Sessions and the Pull-Tool Loop

**Status:** Proposed
**Date:** 2026-09-02
**Author:** William Khoo, Claude
**Builds on:** ADR-027 (Adapter-Protocol Split for the Native LLM Path)
**Related:** ADR-029 (Phase C scope), `@nathapp/nax-ai@0.1.4`, the "Nax Native LLM Harness" feasibility analysis §9-§10
**Design:** `docs/superpowers/specs/2026-09-02-native-sessions-phase-b-design.md`
**Implementation:** none yet.

---

## Context

ADR-027 §10 deferred `openSession`/`sendTurn`/`closeSession` and said why:
the shape of a session boundary depends on what runs across it, and Phase A had
no multi-turn op to learn from. Phase A has since shipped, and the plan-4
experiment ran a real op over the native transport — so the boundary now has
evidence behind it rather than a guess.

ADR-027 also predicted the shape this ADR adopts: *"`openSession` and
`closeSession` become either no-ops or transcript-file handles rather than calls
to a backend that remembers."* That prediction holds. What it could not predict
is what the loop around them looks like, which is most of this decision.

## Decision

### 1. Phase B is read-only agentic ops, not a coding agent

The scope is `tdd-verifier`, `review-semantic` and `review-adversarial`: ops that
are multi-turn and use nax's own **read-only** context pull tools. Coding tools
(Read/Write/Edit/Bash/Glob/Grep), permission enforcement and the implement and
rectify ops are Phase C — see ADR-029.

This matters because "make `kind: "run"` ops work natively" reads as *build a
coding agent*, and that reading would import Phase C's security responsibility
into a phase that does not need it. It also inverts the sequencing the analysis
argues for: A and B together deliver most of the strategic value at roughly a
quarter of the effort, and C is severable.

### 2. nax owns the transcript; nax-ai stays stateless

nax-ai's client takes the full `ConversationMessage[]` every call and remembers
nothing. nax persists the conversation and replays it.

**Sessions are not pushed into nax-ai.** A session is a nax domain concept — it
carries role, workdir, story, scratch dir and completed stages — and moving it
into the client would make a deliberately generic package nax-shaped. That
boundary is the reason nax-ai exists (it isolates pi-ai and gives the
Anthropic-OAuth prohibition exactly one chokepoint), and a session store offers
no comparable forcing function.

### 3. The transcript is a file per session, on disk, adapter-private

One file per session. `SessionDescriptor` gains no message field; instead
`OpenSessionOpts` gains an optional `transcriptDir`, supplied by
`SessionManager`.

It cannot come from the descriptor: `adapter.openSession` is called at
`manager.ts:472` and the descriptor is created afterwards at `:492`, so on a
first open there is no scratch dir yet — and `OpenSessionOpts` carries none
regardless. The manager computes the path with its existing `sessionScratchDir`
dependency, keyed by the session name it already has. **An absent
`transcriptDir` fails loudly**; an adapter that picks its own default path is
#1794's empty-`packageDir` bug one layer up.

On disk from the start even though no Phase B op resumes across a restart: the
transcript is the debugging artifact. The plan-4 root cause was recoverable only
because responses had been persisted, and a native turn that goes wrong leaves
nothing else to read.

Adapter-private rather than a shared nax service, because a shared store would
put a native-only concern into types both transports depend on, for a second
consumer that does not exist.

**Deleted on clean close; kept only when the turn failed.** Transcripts do not
inherit the scratch-dir lifecycle, because there is none — nothing in the repo
deletes a session scratch directory. Inheriting that would make every transcript
permanent, which is the unbounded-growth failure already open as #1445, with
much larger files.

Every Phase B op is `lifetime: "fresh"`, so the session ends with the op and this
costs nothing: the transcript survives exactly when it is worth reading, which is
when something went wrong. If a bound on the kept-on-failure set is later wanted,
`MAX_RETAINED_RUNS` (`src/metrics/tracker.ts:33`) is the existing precedent.

### 4. A transcript write failure fails the turn

It does not warn and continue. Proceeding on a history that could not be
persisted is silent degradation of exactly the kind #1794 removed from the
pipeline, and a saved error path is a poor trade for reintroducing it into a new
subsystem.

### 5. Tool execution goes through the existing InteractionHandler seam

`InteractionHandler.onInteraction({ kind: "context-tool", name, input })` →
`{ answer: string }` is already on `SendTurnOpts`, and the ACP adapter already
uses it (`src/agents/acp/adapter.ts:484-485`). The native adapter uses the same
seam rather than reaching into `ContextToolRuntime` itself.

Budgets, truncation and the audit trail therefore keep working untouched, and the
adapter stays free of context-engine imports. Phase B changes how the model
**asks** — a structured tool-use block instead of a regex-matched text protocol —
and not how nax **answers**.

### 6. The loop honours the existing `maxTurns`, and does not add a second cap

`SendTurnOpts.maxTurns` already exists with a default of 10
(`src/agents/session-types.ts:102-103`). The native loop uses it. A second cap
derived from the tool budget would put two competing limits on one loop with the
caller controlling neither reliably.

The cap is load-bearing rather than defensive: `PullToolBudget.consume()` throws
when the ceiling is already reached **without incrementing**, so a rejected call
costs no budget and a model that keeps asking after exhaustion would loop forever.
`toolChoice` cannot help — it is `"auto" | "none"` with no "required".

### 7. The prompt preamble is suppressed on the native path

The pull-tool catalogue is injected as prompt text because under ACP that is the
only channel. On the native path the same tools arrive as `ToolDefinition`s.
Leaving both in place describes the same tools twice in two protocols and invites
a reply in the text form, which the native path does not parse — so the call
would be silently lost.

The ACP path keeps the preamble and the regex extractor unchanged. This is the
only behavioural change Phase B makes to existing prompt construction.

### 8. Thinking blocks must be appended, not merely representable

nax-ai's `ConversationMessage` now carries `thinking?: readonly ThinkingBlock[]`
with a `signature`, fixed before publication. The turn loop must actually append
what it received. A type with nowhere to put the signature and a loop that drops
it produce the identical defect — Anthropic extended thinking combined with tool
use failing to survive a turn.

### 9. Sessions do not get their own package

The feasibility analysis considered converting nax-ai to a monorepo with a
sibling session package, and declined. Recorded here because "later" otherwise
becomes "never" silently. Its revisit triggers, unchanged:

- a second consumer of the conversation store appears; or
- Phase C's executor exists and its permission gate proves genuinely
  provider-shaped rather than nax-shaped; or
- a hand-rolled protocol lands.

Until one fires, moving a directory into a workspace package stays cheap — and
un-inventing a wrong abstraction does not.

## Consequences

### Positive

- The 25 `kind: "run"` ops stop being categorically unreachable on the native
  path; three become reachable now and the rest become a scoping question rather
  than a blocker.
- The regex tool protocol is replaced by structured tool-use for these ops:
  parallel calls become expressible, and `toolSchemaDialect` starts meaning
  something.
- Cost and provider reach extend to review-shaped work, which is frequent.

### Negative

- nax takes on transcript persistence, which it has never had: a format, a
  retention story, and a new class of on-disk artifact per session.
- A first-cut native loop will likely underperform acpx-mediated agents on review
  quality, because frontier-lab CLIs ship heavily-tuned prompts. The per-op A/B
  exists to measure that rather than assume it away.
- Two tool protocols now coexist — structured on native, regex on ACP — until
  the ACP path is retired, which is not planned.

### Neutral

- All three target ops are `lifetime: "fresh"`, so cross-restart resume is
  designed for but not exercised. The first op that needs it will be the first
  real test of the resume path.
- `toolChoice` has no "required" — a pi-ai ceiling, not a nax-ai narrowing. No
  target op needs a forced call; one that did would need a hand-rolled protocol.

## Open Questions

Both questions raised at design time were answered by checking the code; the
answers are folded into §3 and §9 above and recorded here with their evidence.

1. **Retention — RESOLVED, and it corrected the plan.** Transcripts do *not*
   inherit the scratch-dir lifecycle, because there is no lifecycle to inherit:
   nothing in the repo deletes a session scratch directory, and the directories
   on disk go back months. Inheriting it would mean transcripts are never
   deleted, which is #1445's failure mode ("rollup grows unbounded because gc is
   never invoked") in a second place, with much larger files. See §3.
2. **Iteration cap — RESOLVED as derived, not chosen.** See §9. It could not be
   set empirically: `internalRoundTrips` reaches `manager-dispatch.ts:91` as
   `turn` but appears in no run artifact, so there is no observed distribution to
   fit. Deriving it from the budget is better than a literal anyway, because it
   tracks `maxCallsPerSession` if that is ever raised.
3. **Whether the verifier needs tools at all.** Still open. It declares none
   today. If a native verifier scores worse without the context a pull tool would
   give it, that is an argument about the op rather than about this ADR.

## Implementation

Blocked on one prerequisite: the analysis records that **the nax-ai tool
round-trip has never been proven live** — the live test asserts a tool-call event
is emitted and stops there. All of Phase B rests on feeding a result back and
getting a coherent continuation, so that is task one.
