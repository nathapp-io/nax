# SPEC: Native session context compaction

Design for [#1832](https://github.com/nathapp-io/nax/issues/1832). Status: approved design, not yet implemented.

## Summary

The native turn loop runs `while (true)` and only ever appends to `messages`. Nothing summarizes or truncates, and nothing compares the conversation against the model's context window. A long story eventually exceeds the window.

This spec adds compaction: when the estimated conversation crosses a percentage of the model's window, the older span is replaced by a model-written summary, and the recent span survives verbatim.

## What already shipped

Compaction was blocked behind three defects, all now fixed. They are listed because the design depends on each.

| | what it gives this design |
|---|---|
| `@nathapp/[email protected]` (nax-ai#26) | a `context-overflow` error kind, distinct from `bad-request`. Makes the reactive backstop possible. |
| nax#1837 | maps that kind to `availability` / `fail-adapter-error` / not retriable, so an overflow is swap-eligible rather than terminal. |
| nax#1839 | the run path now carries typed failures, and **a failed turn keeps its transcript**. Without this, compaction would summarize history that the next failure silently erased. |

[#1840](https://github.com/nathapp-io/nax/issues/1840) (a failed native turn reports zero cost) is open and interacts with this design — see *Known interactions*.

## Decisions

Each was chosen deliberately; the rejected option is recorded so it is not silently revisited.

**What replaces the dropped span: an LLM summary plus a file record.** Modelled on `@earendil-works/pi-coding-agent`'s `dist/core/compaction/`, which solves the same problem under the same constraints. The rejected alternatives were a structural drop with no summary (the agent re-tries approaches it already abandoned, with no record of why) and a mechanical ledger rebuilt from nax's context engine (records what happened, never why).

**Which model writes the summary: the turn's own model.** No new config, no new resolution path, and the summary is written by a model already trusted with the story. Summary quality is load-bearing — a weak summary silently degrades the agent for every remaining turn and nothing detects it — so a cheaper tier was rejected. A `compaction.model` override was rejected as surface added before evidence it is needed.

**Trigger: proactive threshold with a reactive backstop.** Estimate before each round trip and compact on crossing. If an overflow still arrives, compact harder and retry once.

Proactive alone leaves a known gap: `runNativeTurn` reloads the transcript from disk on *every* turn, so without an in-process usage anchor the estimate has nothing exact to anchor on after a process restart. Reactive alone stakes the whole feature on nax-ai's overflow marker table, which was built from provider documentation rather than live captures (stated in nax-ai#26 and in that code's own comment) — a reworded provider error would disable compaction silently.

## Architecture

### Module

`src/agents/native/session/compaction.ts` — **pure functions only**. No file I/O, no model calls, no clock. This is how pi splits it (`compaction.ts` is pure; the session manager does I/O) and it is what makes the algorithm unit-testable rather than reachable only end-to-end.

Orchestration stays in `turn-loop.ts`, which owns the I/O and the model call.

### Seams

`TurnDeps` gains two members:

```ts
export interface TurnDeps {
  complete(messages, tools): Promise<NativeTurnResponse>;
  /** One model call, no tools, used only to summarize a dropped span. */
  summarize(messages: readonly ConversationMessage[]): Promise<NativeSummaryResponse>;
  //   NativeSummaryResponse = { text: string; usage: TokenUsage; costUsd: number }
  //   Usage and cost are returned, not swallowed: the caller adds them to the
  //   turn's totals and emits them as activity.
  /** ResolvedModel.contextWindow. Absent disables compaction. */
  contextWindow?: number;
  deadline?: TurnDeadline;
  onActivity?: (activity: NativeTurnActivity) => void;
}
```

`summarize` is separate from `complete` rather than a reuse of it because it must not advertise tools, must not count as a round trip in `internalRoundTrips`, and its cost must be attributable. The adapter supplies both from the same `client` and `resolved` model, which is what makes "the turn's own model" free to implement.

`contextWindow` is optional so existing turn-loop tests keep compiling. Absent means compaction never triggers — also the honest behaviour when a catalog entry lacks a window.

### Configuration reaches the adapter as resolved primitives

`src/agents/native/` must not read `NaxConfig`, matching the rule enforced on `src/agents/acp/` by `check-adapter-no-config-import.sh` and the existing `timeoutSeconds` / `resolvedPermissions` precedent on `OpenSessionOpts`.

So: the session layer resolves `execution.compaction` and passes it on `OpenSessionOpts.compaction`; `openNativeSession` stores it in a module map beside `nativeSessionTimeouts`; `sendTurn` reads it back.

**Extend `scripts/check-adapter-no-config-import.sh` to scan `src/agents/native/` as well.** The rule is currently only enforced for the ACP adapter, so nothing stops a future edit importing `NaxConfig` here. A prose convention without a gate is a comment.

### Token anchor

A module-level `nativeSessionLastUsage` map in `session/session.ts`, beside the three that already live there. Written after each round trip, cleared on close.

This is load-bearing rather than an optimisation: `runNativeTurn` reloads the transcript from disk on every turn, so without it the second turn of every session would be estimated from scratch. A genuine process restart still loses the anchor, which is the case the reactive backstop exists to cover.

### Data flow, per round trip

```
loadTranscript -> messages
  |
estimateContextTokens(messages, lastUsage)      pure
  |  over threshold?
prepareCompaction(messages, keepBudget(...))    pure: pin, cut point, span to drop
  |
deps.summarize(span)                            the one model call
  |
applyCompaction(...)                            pure: new array
  |
deps.complete(messages, tools)                  unchanged
```

The transcript **file format does not change**. It stays `ConversationMessage[]`, so `loadTranscript` / `saveTranscript` and everything #1839 fixed are untouched.

## Algorithm

### Estimation

Anchor on truth, guess only the tail:

```
estimateContextTokens(messages, lastUsage) =
    lastUsage.inputTokens                              // exact, provider-reported
  + sum(estimateTokens(m) for m after the anchor)      // chars/4
```

`estimateTokens` counts characters and divides by four: text, thinking text, tool-call name plus serialized arguments, tool-result content. Over-estimating is the safe direction — it compacts slightly early rather than overflowing. With no anchor every message is estimated.

### Threshold

The threshold is a **percentage of the window**, with an absolute floor so it degrades on small windows.

```ts
const MIN_HEADROOM_TOKENS = 4096;      // a reply needs room whatever the window
const MAX_HEADROOM_FRACTION = 0.25;    // but never take a quarter of a tiny window

export function compactionThreshold(window: number, cfg: ResolvedCompaction): number {
  const headroom = Math.min(MIN_HEADROOM_TOKENS, Math.floor(window * MAX_HEADROOM_FRACTION));
  return Math.min(Math.floor(window * (cfg.compactAtPercent / 100)), window - headroom);
}

export function shouldCompact(tokens: number, window: number, cfg: ResolvedCompaction): boolean {
  return cfg.enabled && tokens > compactionThreshold(window, cfg);
}

/**
 * How much recent conversation survives verbatim, in tokens.
 * `aggressive` halves it — the reactive backstop's only difference.
 */
export function keepBudget(window: number, cfg: ResolvedCompaction, aggressive = false): number {
  const budget = Math.floor(window * (cfg.keepRecentPercent / 100));
  return aggressive ? Math.floor(budget / 2) : budget;
}
```

The two constants are **not config**. They are a safety rail against a window smaller than the defaults assume, not a knob with a decision behind it.

Measured against the real catalog (all 1290 models nax-ai ships: min 4095, p10 128000, p50 262144, p90 1048576, max 3500000):

| window | 90% of window | floor allows | threshold | effective |
|---|---|---|---|---|
| 4,095 | 3,685 | 3,072 | 3,072 | 75% (floor wins) |
| 128,000 | 115,200 | 123,904 | 115,200 | 90% |
| 262,144 | 235,929 | 258,048 | 235,929 | 90% |
| 1,048,576 | 943,718 | 1,044,480 | 943,718 | 90% |

An earlier draft of this design used pi's absolute constants (`reserveTokens: 16384`, `keepRecentTokens: 20000`) unchanged. Against the 7 catalog models with a window at or below 16384, `window - 16384` is negative, so compaction fires on every round trip; and `keepRecentTokens` exceeding the window means the cut point walk never reaches its budget and keeps everything. The pairing is a summary call per round trip that shrinks nothing. Percentages remove that class of failure at both ends of the distribution.

### Pinning

`messages[0]` — the op's prompt carrying the story and spec context — is never summarized and never dropped.

There is no system role on this path: `ConversationMessage` is `user | assistant | tool-result`, and the native path sends no system prompt. That first user message *is* the task definition.

### Cut point

Walk backwards from the newest message accumulating estimated tokens; stop once `keepBudget(window, cfg)` is reached; move to the nearest valid cut at or after that point.

**Valid cut: `role === "user" || role === "assistant"`. Never `tool-result`.**

That one rule enforces both hard constraints from #1832:

1. a `tool-result` can never become the first kept message, so it is never orphaned from its `tool_use` — which would land in the same `bad-request` bucket the issue describes;
2. cuts land between messages, never inside an assistant message, so a kept `thinking` block keeps its exact text and `signature` for the ADR-028 section 8 replay.

Constraint 2 holds in pi as a consequence of message-granularity cuts rather than as a stated intent. Here it is explicit and gated by a test that constructs a transcript whose only naive cut would split an assistant message and asserts the refusal.

### Building the compacted array

```
[ messages[0],                                             // pinned, byte-identical
  { role: "user", content: PREFIX + summary + SUFFIX },
  ...messages.slice(cutIndex) ]
```

The summary is a separate message rather than appended into `messages[0]` so the pinned prompt stays byte-identical and the provider's prompt cache can still hit on that prefix. Compaction invalidates everything after it regardless; there is no reason to also invalidate the one block that could survive.

It carries no marker field. `NativeTranscriptMessage` values reach `deps.complete` structurally, so extra properties travel to the wire — verified against the existing `denied` marker, which does exactly that. The summary is therefore identified by position (index 1) and validated by its content prefix, as pi does with `COMPACTION_SUMMARY_PREFIX`.

On a **second** compaction the previous summary is found at index 1, passed to the summarizer as `previousSummary`, and replaced. Merged, not stacked — otherwise summaries accumulate and consume the window they exist to protect.

The summary prompt asks for what a coding agent needs back: what was tried, what was rejected and why, and a mechanical file record (`read` / `modified`) extracted from tool calls in the dropped span — pi's `CompactionDetails`, which is what stops the agent re-reading files it already read.

### Aggressive mode

The reactive backstop is the same code path called with `keepBudget(window, cfg, true)` — half the usual budget. Not a second algorithm.

## Configuration

```ts
// src/config/schemas-execution.ts, inside ExecutionConfigSchema
compaction: z
  .object({
    enabled: z.boolean().default(true),
    compactAtPercent: z.number().int().min(50).max(99).default(90),
    keepRecentPercent: z.number().int().min(5).max(60).default(30),
  })
  .refine((c) => c.keepRecentPercent <= c.compactAtPercent - 20, {
    message: "keepRecentPercent must be at least 20 points below compactAtPercent",
  })
  .default({ enabled: true, compactAtPercent: 90, keepRecentPercent: 30 }),
```

Mirrored in `src/config/runtime-types.ts`.

The cross-field refine is required, not decorative: the field ranges alone permit `keepRecentPercent: 60` with `compactAtPercent: 50`, where a compacted transcript still sits above its own trigger and would re-fire every round trip.

`keepRecentPercent` is a percentage rather than pi's absolute 20000 for the same reason the threshold is. On a 262k window, 20000 absolute means compacting from 236k down to 20k — a 12x cut that discards most of the conversation to buy a long gap before the next compaction. 30% keeps 78k: compaction runs somewhat more often and the agent loses far less each time, which is the better side of that trade mid-story.

## Error handling

**A failed summary does not fail the turn.** Log a warning, leave `messages` untouched, send the request anyway — it may still fit, and if it does not it overflows into the failure path #1837 and #1839 made correct. One attempt per round trip, and a summarization failure disarms the reactive backstop for that round trip, so we do not pay twice to fail the same way.

**The summary call respects the turn's clock.** It takes the same remaining-time budget and the same combined `AbortSignal` as a normal round trip. A deadline expiring mid-summary ends the turn as timed-out; compaction gets no exemption from the budget.

**Compaction emits stream activity.** `onActivity` exists so the idle watchdog can see native sessions. A summarization call otherwise emits nothing, and a slow summary over a long transcript is exactly the silence the watchdog cancels. Activity is emitted at start and completion, plus usage. Without this the feature's main observable effect would be getting long sessions killed.

**Degenerate cases terminate.**

- *Nothing to drop* — the span between the pin and the cut point is empty. No-op, logged once, request proceeds.
- *Still over after compacting* — the pinned prompt alone exceeds the window. No amount of compaction fixes it.

Compaction runs **at most once per round trip** and never re-enters. That bound is what stops a compact-still-over-compact loop, and it is why the backstop retries once rather than until it fits.

**Cost and counting.** The summary call's cost is added to the turn's `costUsd` and its usage emitted as activity. It does **not** increment `internalRoundTrips` — that number means "times the model asked for tools", and inflating it corrupts the metric ADR-028 uses to compare native against acpx.

## Known interactions

**With #1839 (accepted regression).** #1839 made a failed turn persist its transcript so the retry resumes with history. Compaction rewrites that history in place, so a turn that compacts and then fails persists the *compacted* array and the raw dropped span is gone from disk.

This is accepted rather than designed around. pi can keep everything because its session file is already an append-only tree; for nax, snapshots would be new machinery with unbounded growth and a second pruning policy. Instead each compaction emits a structured log event — `tokensBefore`, `tokensAfter`, messages dropped, summary length — so a post-mortem can see that it happened and how much went. If that proves too thin, pre-compaction snapshots beside the transcript are the next step and `pruneRetainedTranscripts` is where they would be bounded.

**With #1840 (sharpened).** Compaction spends real money inside a turn. Because a failed native turn currently reports zero cost, a story that compacted three times and then failed reports as free. The two are not coupled in code, but #1840 moves from an accounting nicety to something that actively hides spend once this ships.

## Testing

Compaction gets `test/unit/agents/native/compaction.test.ts` of its own. `turn-loop.test.ts` is already 577 lines against the 800-line test cap and would be pushed over.

Pure-function tests carry most of the weight — the payoff for keeping the module pure:

| test | what regresses without it |
|---|---|
| never cuts at a `tool-result` | a `tool_use` orphaned from its result, landing in the `bad-request` bucket |
| refuses a cut that would split an assistant message | a thinking block loses its `signature`, violating ADR-028 section 8 |
| `messages[0]` byte-identical after compaction | the pinned task is lost, or the cacheable prefix is invalidated for nothing |
| second compaction replaces the summary at index 1 | summaries stack and consume the window they protect |
| estimate anchors on reported usage, guesses only the tail | silent drift toward overflow |
| **a 4095-token window terminates and actually shrinks** | the absolute-constant failure above returns |

4095 is named explicitly because it is the catalog minimum, not an invented number. Both sides are pinned throughout: a transcript whose only valid cut is a `tool-result` asserts we *refuse*, not merely that we usually do not.

Orchestration tests run through `runNativeTurn` with a fake `summarize`:

- summarize throws — turn proceeds, transcript untouched, backstop disarmed for that round trip
- overflow after a proactive compaction — backstop compacts harder and retries **once**, not twice
- compaction emits `onActivity` (the watchdog test)
- the summary call does not increment `internalRoundTrips`
- `contextWindow` absent — never compacts, existing behaviour unchanged

## Pre-merge gate: live probe

The compacted array is `[user(pinned), user(summary), ...kept]`, and when the cut lands on a user message, three consecutive user messages. Our transcripts contain no consecutive user messages today. pi ships two-in-a-row against real providers, which is evidence for two and not proof for three, and Anthropic has historically been strict about alternation.

**Before merge, probe a real Anthropic model and one OpenAI-family model with a three-consecutive-user-message request.** A scripted test proves our mapping, never a provider's behaviour.

If a provider rejects it, the fallback is already decided: merge the summary into `messages[0]` as a single user message and give up that cache block. A red probe does not reopen the design.

## Out of scope

- Persisting usage in the transcript file. The in-process anchor plus the reactive backstop covers it; a format change would touch everything #1839 stabilised.
- Pre-compaction snapshots (see *Known interactions*).
- Compaction on the ACP path. acpx owns its own conversation; nothing here applies.
- Fixing #1840.
