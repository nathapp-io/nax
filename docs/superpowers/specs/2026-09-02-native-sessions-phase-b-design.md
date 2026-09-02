# Phase B — native sessions and the pull-tool loop

Date: 2026-09-02
Status: PROPOSED
Depends on: Phase A (ADR-027, shipped)
Decision record: ADR-028
Feasibility analysis: "Nax Native LLM Harness" §9 (phasing), §10 (what building it revealed)

## 1. What this is

Phase A gave the native transport a working `complete()`. Phase B gives it
**sessions** — the multi-turn conversations that `kind: "run"` ops need — and
replaces nax's regex tool protocol with real tool-use blocks on that path.

**In scope:** transcript persistence, the turn loop, and pull-tool dispatch for
the read-only agentic ops (`tdd-verifier`, `review-semantic`,
`review-adversarial`).

**Out of scope:** Read/Write/Edit/Bash/Glob/Grep, permission enforcement, and
the implement/rectify ops. That is Phase C (ADR-029), which the analysis calls
"the real project" and "severable". Nothing here executes a coding tool or a
shell command.

## 2. Why the scope stops where it does

The analysis §9 splits the work three ways, and the split is load-bearing:

| Phase | Ops | Tools | Size |
|---|---|---|---|
| A (done) | 7 `complete` ops | none | ~1.5–2.5k LOC |
| **B (this)** | **read-only agentic run ops** | **nax's own read-only pull tools** | **~1–2k LOC** |
| C | implement / rectify | Read/Write/Edit/Bash + permissions | ~5–8k LOC |

The three capabilities once raised as blockers resolve differently (§10):

- **Sessions — a real gap, and nax's to close.** nax has never stored a
  transcript: `SessionDescriptor` (`src/session/types.ts:65`) carries id, role,
  state, agent, workdir and handle, and no message array. Under ACP the acpx
  subprocess remembers. nax-ai's client is stateless — the caller passes the full
  `ConversationMessage[]` every turn — so nax must persist and replay them.
- **Permissions — already satisfied for this phase.** `resolvePermissions`
  (`src/config/permissions.ts:80`) decides once, up front, and the result becomes
  a spawn flag. There is no `canUseTool`-style callback anywhere in
  `src/agents/`, and the stream never pauses for approval. The bill lands in
  Phase C, when nax first becomes the executor of a coding tool.
- **Tool calling — satisfied, and an upgrade.** Today the pull-tool catalogue is
  injected as a **prompt preamble** and the call is **regex-matched out of
  assistant text** (`extractContextToolCall`, `src/agents/acp/adapter-output.ts:76`),
  executed client-side, and the result returned as a brand-new prompt: one call
  per turn, no parallelism. Structured tool-use replaces that.

## 3. Target ops, and why these three

| op | multi-turn | pull tools | writes or executes |
|---|---|---|---|
| `tdd-verifier` | yes — in-session re-prompt on verdict parse failure | **none** | no |
| `review-semantic` | yes | `query_feature_context` | no |
| `review-adversarial` | yes | `query_feature_context` | no |

(Tools per `src/context/engine/stage-config.ts`.)

This ordering is the validation strategy, not a preference. **The verifier is
toolless and multi-turn, so it exercises the transcript store in isolation** —
if a native verifier produces a verdict and its parse-retry re-prompt sees the
prior turn, storage works. The two reviews then add exactly one read-only tool
and exercise the loop. A failure in the first group is a storage bug; a failure
only in the second is a tool-loop bug.

All three sessions are `lifetime: "fresh"`, so none of them exercises
cross-restart resume. The transcript is still written to disk (§5).

## 4. Architecture

Everything new lives under `src/agents/native/session/`. `NativeAgentAdapter`
implements the three methods it currently rejects. `SessionDescriptor`,
`SessionHandle`, `SessionManager` and the entire ACP path are unchanged.

**Tool execution is not rebuilt, and the adapter does not reach for it.** The
seam is `InteractionHandler.onInteraction({ kind: "context-tool", name, input })`
→ `{ answer: string }` (`src/agents/interaction-handler.ts`), already carried on
`SendTurnOpts`. The ACP adapter uses exactly this
(`src/agents/acp/adapter.ts:484-485`); the native adapter uses it too.

That keeps budgets, truncation and the audit trail working unchanged, and keeps
the adapter free of context-engine imports — `ContextToolRuntime` stays behind
the handler, where the ACP adapter also leaves it. The native path therefore
differs from ACP in **how a tool call is detected** (structured block vs regex),
not in how it is executed.

Four files:

1. **`transcript-store.ts`** — load, append and flush `ConversationMessage[]`
   for one session id.
2. **`session.ts`** — `openSession` / `closeSession`.
3. **`turn-loop.ts`** — `sendTurn`, including the tool loop.
4. **`tool-mapping.ts`** — `ToolDescriptor` → `ToolDefinition`.

## 5. Transcript store

One file per session, JSON array of `ConversationMessage`, rewritten on flush.

**Its directory arrives on `OpenSessionOpts`, as a new optional
`transcriptDir?: string`.** The adapter cannot use the descriptor's `scratchDir`:
`SessionManager` calls `adapter.openSession` at `manager.ts:472` and only creates
the descriptor afterwards at `:492`, so on a first open no scratch dir exists yet
— and `OpenSessionOpts` carries none in any case. `SessionManager` computes the
path with its existing `sessionScratchDir` dependency (`manager-deps.ts:34`),
keyed by the session **name** it already holds rather than the id it has not yet
generated, and passes it in. The ACP adapter ignores the field.

**If `transcriptDir` is absent the native adapter fails loudly** rather than
choosing a default. An adapter that silently picks its own path is the
empty-`packageDir` bug fixed in #1794, one layer up.

**On disk from the start, deliberately**, even though no target op can resume
across a restart. The transcript is the debugging artifact: when a native review
goes wrong, the message array is the only record of why. Prompt-audit earned
that argument this week — the plan-4 root cause was recoverable *only* because
the responses had been persisted.

**Deleted on clean close, kept only when the turn failed.** Transcripts do not
inherit the scratch-dir lifecycle: nothing in the repo deletes a session scratch
directory, so inheriting it means never deleting them — #1445's unbounded-growth
failure in a second place, with much larger files. Every Phase B op is
`lifetime: "fresh"`, so the session ends with the op and the transcript survives
exactly when it is worth reading. `MAX_RETAINED_RUNS` (`src/metrics/tracker.ts:33`)
is the precedent if the kept-on-failure set later needs a bound.

**A write failure fails the turn.** It does not warn and continue. A turn that
proceeds on a history it could not persist is the silent-degradation shape
#1794 removed from the pipeline, and reintroducing it in a new subsystem would
be a poor trade for one saved error path.

## 6. The turn loop

`sendTurn(handle, prompt, opts)`:

1. Load the transcript for `handle.id`.
2. Append `{ role: "user", content: prompt }`.
3. Call `complete()` with the messages and the mapped tool definitions.
4. Append the assistant message — **including its `thinking` blocks** (§8).
5. If it carries `toolCalls`: execute each through `ContextToolRuntime.callTool`,
   append one `{ role: "tool-result", toolCallId, content }` per call, and return
   to step 3.
6. Otherwise persist and return `TurnResult`.

`internalRoundTrips` is the number of `complete()` calls, mirroring what it
counts for ACP (`session.prompt()` calls). Token usage accumulates across the
whole loop, so the returned `TurnResult` describes the turn rather than its last
leg.

**The cap already exists: `SendTurnOpts.maxTurns`, default 10**
(`src/agents/session-types.ts:102-103`). The native loop honours it. Inventing a
second cap derived from the tool budget would put two competing limits on one
loop, and the caller would control neither reliably.

The cap is load-bearing rather than defensive. `PullToolBudget.consume()`
(`src/context/engine/pull-tools.ts:326`) throws when the ceiling is already
reached **without incrementing**, so a rejected call costs no budget — a model
that keeps asking after exhaustion would loop forever with nothing to stop it.
`toolChoice` cannot help: it is `"auto" | "none"` with no "required", a pi-ai
ceiling rather than a nax-ai narrowing.

On hitting `maxTurns` the turn ends with the output it has and records that it
did.

## 7. Suppressing the prompt preamble

This is the one behavioural change to existing prompt construction, and it is
required for correctness rather than tidiness.

The pull-tool catalogue is injected into the prompt as text, because under ACP
that is the only channel. On the native path the same tools arrive as structured
`ToolDefinition`s. Leaving both in place describes the same tools twice in two
different protocols and invites the model to answer in the text form — which the
native path does not parse, so the call would be silently lost.

So: when the dispatching agent is native, the catalogue preamble is omitted and
`extractContextToolCall` is not consulted. **The ACP path keeps both, unchanged.**

The suppression point is **not** inside the ACP adapter, despite
`buildContextToolPreamble` living at `src/agents/acp/adapter-output.ts:166`. It
is called from two transport-agnostic sites — `src/runtime/session-run-hop.ts:21`
and `src/operations/build-hop-callback.ts:280` — both of which already have
`agentName` in scope. A single shared helper gates both, so the two cannot drift
and a third call site is not written without the guard.

## 8. Thinking blocks must round-trip

The analysis found that nax-ai's `ConversationMessage` had nowhere to carry
Anthropic's thinking signature, so extended thinking combined with tool use could
not survive a turn. It was fixed before publication: the assistant variant now
carries `thinking?: readonly ThinkingBlock[]`, and `ThinkingBlock` has a
`signature` field (verified against 0.1.4).

The type existing is not the same as the loop using it. Step 4 above must append
the thinking blocks it received, or the defect returns at the nax layer with the
same symptom. This is a required behaviour, not an optimisation.

## 9. Error handling

- **Tool budget exceeded / handler throws** — returns a `tool-result` with
  `isError: true`. Consistent with the existing pull-tool contract, where a
  handler throw is safe and surfaces as `status: "error"`.
- **Unknown tool name** — same shape. The model is told, and the loop continues.
- **Iteration cap reached** — the turn returns normally with the output so far,
  and the cap is recorded on the result so it is visible in the run log.
- **Transcript write failure** — the turn fails (§5).
- **Provider/transport failure** — unchanged from Phase A: mapped through
  `toAdapterFailure` so the manager's existing swap and retry policy applies.

## 10. Testing

- **Unit:** transcript round-trip including thinking blocks; the loop's exit
  conditions (no tool calls, cap reached, tool error); tool mapping; preamble
  suppression on native and its retention on ACP.
- **Live, first:** prove the nax-ai tool round-trip end-to-end before anything
  is built on it (§11).
- **Fixture A/B, per op:** verifier, then the two reviews, against acpx on the
  same fixture using the profile mechanism — the method Phase A used. Compare
  verdict agreement and tokens; do not switch any default until an op passes.

## 11. Risks

- **The tool round-trip has never been proven live.** The analysis §10 records
  that the live test asserts a tool-call event is emitted and stops there;
  feeding a result back and getting a coherent continuation is only unit-tested
  against the request builder. Every part of Phase B rests on it, so proving it
  is task one, before the design is committed to code.
- **Prompt-behaviour drift.** acpx-mediated agents ship heavily-tuned prompts. A
  first-cut native loop may score worse on review quality. That is what the
  per-op A/B is for, and a worse score is a result, not a failure of the design.
- **No forced tool call.** An op that ever *requires* a tool call cannot get one
  from `toolChoice`. None of the three target ops requires it; an op that did
  would need the hand-rolled-protocol path the analysis describes.

## 12. Out of scope, explicitly

- Coding tools, permission enforcement, implement/rectify ops — Phase C
  (ADR-029).
- Extracting sessions into their own package. The analysis considered and
  **declined** this: nax-ai stays one package, sessions and permissions are built
  in nax. Its three revisit triggers are recorded in ADR-028.
- Changing any op's default agent. Every op stays on acpx until its A/B passes.
