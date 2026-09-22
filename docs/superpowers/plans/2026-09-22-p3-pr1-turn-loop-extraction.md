# P3 PR 1 — turn-loop.ts extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `src/agents/native/session/turn-loop.ts` (599/600 lines) into focused modules with **zero behaviour change**, so P3's loop events have one dispatch site each and the file has room to grow.

**Architecture:** The file is one 548-line function (`runNativeTurn`) wrapping one `while (true)`, with ~17 mutable locals threaded through it. Six of those locals are accumulated by an identical 10-line block appearing three times; collapsing them into a `TurnAccumulator` is what makes every other extraction's signature narrow enough to be worth doing. Extractions then proceed leaf-first, each verified by the existing suite before the next begins.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-22-p3-loop-events-design.md` — §5 is this plan's section. Read §5.1 (why), §5.2 (the obstacle), §5.3 (the unlock), §5.4 (the carve-up) and §5.5 (the proof obligation) before Task 1.

## Global Constraints

- **PR 1 adds NO new loop events, NO async registry, NO cache-boundary checker.** Those are PR 2. This PR moves code and changes nothing else.
- **🚨 ZERO test file edits.** This is the entire proof obligation (spec §5.5). `turn-loop.ts` has exactly one export (`runNativeTurn`, `:52`); all eleven test files importing from it import only that symbol, and three more reach it via `adapter.ts`. **If a test needs an edit, the refactor has stopped being pure — STOP, report it, and do not "fix" the test.**
- **600-line limit** on files under `src/`, enforced by `scripts/check-file-sizes.ts` (`SRC_LIMIT = 600`). Not grandfathered for this work. (`CLAUDE.md` says 400; the script says 600 — the script is authoritative.)
- **Bun-native APIs only.** No Node.js equivalents.
- **No `any`** in public APIs. TypeScript strict.
- **Preserve every comment verbatim** when moving code. The comments in this file cite issue numbers (nax#1838, #1852, #1870, #2013, #2047, #2120, #2162, ADR-028 §8) and record why each branch exists. A moved comment that loses its issue reference destroys the only record of that decision.
- **Conventional commits**, one concern per commit.
- Full suite: `bun run test`. Targeted: `bun test <path> --timeout=30000`. Never bare `bun test` with no path.
- Static gates: `bun run typecheck` and `bun run lint`. The pre-commit hook runs both plus 31 check scripts; expect it to run on every commit.

## The 14 test files that must pass unedited

Import `runNativeTurn` directly (11):

```
test/unit/agents/native/turn-loop.test.ts
test/unit/agents/native/turn-loop-usage.test.ts
test/unit/agents/native/turn-loop-compaction.test.ts
test/unit/agents/native/turn-loop-transport-retry.test.ts
test/unit/agents/native/session/turn-loop-seam.test.ts
test/unit/agents/native/session/turn-loop-seam-regressions.test.ts
test/unit/agents/native/session/turn-loop-invalid-input.test.ts
test/unit/agents/native/session/native-truncation-nudge.test.ts
test/unit/agents/native/session/native-truncation-chokepoint.test.ts
test/unit/agents/native/session/us-003-acs.test.ts
test/unit/agents/native/session/session-lifetime-spin.test.ts
```

Reach it via `adapter.ts` (3):

```
test/unit/agents/native/adapter.test.ts
test/unit/agents/native/adapter-complete-rates.test.ts
test/unit/agents/native/session/loop-events.test.ts
```

Save this as a shell variable at the start of each task:

```bash
TURN_TESTS="test/unit/agents/native/turn-loop.test.ts test/unit/agents/native/turn-loop-usage.test.ts test/unit/agents/native/turn-loop-compaction.test.ts test/unit/agents/native/turn-loop-transport-retry.test.ts test/unit/agents/native/session/turn-loop-seam.test.ts test/unit/agents/native/session/turn-loop-seam-regressions.test.ts test/unit/agents/native/session/turn-loop-invalid-input.test.ts test/unit/agents/native/session/native-truncation-nudge.test.ts test/unit/agents/native/session/native-truncation-chokepoint.test.ts test/unit/agents/native/session/us-003-acs.test.ts test/unit/agents/native/session/session-lifetime-spin.test.ts test/unit/agents/native/adapter.test.ts test/unit/agents/native/adapter-complete-rates.test.ts test/unit/agents/native/session/loop-events.test.ts"
```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/agents/native/session/turn-accumulator.ts` | Create | The six usage/cost/rate counters and the `onActivity` usage beat |
| `src/agents/native/session/turn-ask-human.ts` | Create | The `ASK_HUMAN_TOOL_NAME` branch — budget refusal, unreachable operator, recorded exchange |
| `src/agents/native/session/turn-compaction-step.ts` | Create | Proactive compaction and reactive overflow recovery |
| `src/agents/native/session/turn-complete-step.ts` | Create | `deps.complete` plus transport-retry and overflow recovery |
| `src/agents/native/session/turn-tool-batch.ts` | Create | The per-batch tool-call loop |
| `src/agents/native/session/turn-result.ts` | Create | `TurnResult` assembly and the two tail warnings |
| `src/agents/native/session/turn-loop.ts` | Modify | Setup, the `while`, and orchestration between steps |

---

### Task 1: `TurnAccumulator` — collapse the triplicated usage block

**Files:**
- Create: `src/agents/native/session/turn-accumulator.ts`
- Modify: `src/agents/native/session/turn-loop.ts:86-96` (declarations), `:192-210`, `:282-300`, `:307-348`, `:575-585` (result assembly reads)
- Test: none new — the existing suite is the test (see Global Constraints)

**Interfaces:**
- Consumes: `TokenUsage` from `@/agents/session-types`, `ResolvedRates` from `../../cost`, `addRateTotals`/`aggregateRates`/`createRateTotals` from `./rate-provenance`, `cacheUsageFields` from `./turn-types`
- Produces:
  - `createTurnAccumulator(): TurnAccumulator`
  - `interface TurnAccumulator { add(usage, costUsd, rates?): void; totals(): TurnUsageTotals; rates(): ResolvedRates | undefined }`
  - `interface TurnUsageTotals { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUsd: number }`
  - `usageBeat(usage: TokenUsage, costUsd: number, roundTrip?: number): AgentActivity`
  - Tasks 3, 4 and 5 all take a `TurnAccumulator` parameter.

- [ ] **Step 1: Read the three blocks being collapsed**

```bash
sed -n '192,210p' src/agents/native/session/turn-loop.ts   # proactive compaction
sed -n '282,300p' src/agents/native/session/turn-loop.ts   # reactive overflow
sed -n '307,348p' src/agents/native/session/turn-loop.ts   # round trip
```

Confirm by eye: `:192-201`, `:282-291` and `:307-316` are the same ten lines with `summary`/`res` swapped. The `deps.onActivity({kind: "usage", ...})` beat that follows each is **near**-identical — the round-trip one at `:337-348` additionally carries `roundTrip: roundTrips`. That difference is why `usageBeat` takes an optional `roundTrip` and is a separate function from `add`.

- [ ] **Step 2: Create the accumulator**

```typescript
/**
 * The six usage/cost/rate counters `runNativeTurn` accumulates.
 *
 * Extracted because the same ten lines appeared three times — after a
 * proactive compaction summary, after a reactive overflow summary, and after
 * each round trip — and a fourth copy was one loop event away. A factory
 * returning an object, matching `createRateTotals` and `createInvalidCallBudget`.
 *
 * `add` and `usageBeat` are deliberately separate: the round-trip beat carries
 * `roundTrip` and the two summary beats do not, so folding the beat into `add`
 * would either drop that field or fabricate it for the summaries.
 */

import type { TokenUsage } from "@/agents/session-types";
import type { ResolvedRates } from "../../cost";
import { addRateTotals, aggregateRates, createRateTotals } from "./rate-provenance";
import { cacheUsageFields } from "./turn-types";

export interface TurnUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Undefined until something reports cache data, then a running sum. Staying
   * undefined when nothing ever reports it preserves the absent/zero
   * distinction `toNaxTokenUsage` establishes: "no cache data" and "zero cache
   * tokens" must stay distinguishable downstream (nax#2045).
   */
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly costUsd: number;
}

export interface TurnAccumulator {
  add(usage: TokenUsage, costUsd: number, rates?: ResolvedRates): void;
  totals(): TurnUsageTotals;
  /** Aggregated rate provenance, or undefined when nothing priced. */
  rates(): ResolvedRates | undefined;
}

export function createTurnAccumulator(): TurnAccumulator {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let costUsd = 0;
  const rateTotals = createRateTotals();

  return {
    add(usage, addedCostUsd, rates) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (usage.cacheReadInputTokens !== undefined) {
        cacheReadInputTokens = (cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
      }
      if (usage.cacheCreationInputTokens !== undefined) {
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
      }
      costUsd += addedCostUsd;
      addRateTotals(rateTotals, usage, rates);
    },

    totals() {
      return {
        inputTokens,
        outputTokens,
        ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
        ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
        costUsd,
      };
    },

    rates() {
      return aggregateRates(rateTotals);
    },
  };
}

/**
 * The `onActivity` usage beat. `roundTrip` is 1-based and omitted for the two
 * compaction-summary beats, which are not round trips.
 */
export function usageBeat(
  usage: TokenUsage,
  costUsd: number,
  roundTrip?: number,
): {
  kind: "usage";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  roundTrip?: number;
} {
  return {
    kind: "usage",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    ...cacheUsageFields(usage),
    ...(roundTrip !== undefined ? { roundTrip } : {}),
  };
}
```

- [ ] **Step 3: Check the `usageBeat` return type against the real one**

The literal return type above is a guess at `AgentActivity`'s usage variant. Find the real type and use it rather than the inline literal:

```bash
grep -rn "kind: \"usage\"" src/agents/session-types.ts src/runtime/*.ts | head
grep -rn "onActivity" src/agents/native/session/turn-types.ts
```

Replace `usageBeat`'s return annotation with the actual named type. If `cacheUsageFields` already widens it correctly, annotate as that type and let TypeScript check the literal. **Do not use `any` or a cast** — if the types do not line up, that is a real finding: report it.

- [ ] **Step 4: Rewire the three call sites in `turn-loop.ts`**

Delete the six declarations at `:86-96` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUsd`, `rateTotals`) and add:

```typescript
const usage = createTurnAccumulator();
```

Then at each of the three sites replace the ten-line block plus its beat:

```typescript
// proactive compaction (was :192-210)
usage.add(summary.usage, summary.costUsd, summary.rates);
// Resets the watchdog's lastActivityAt between the summary and the round
// trip, so the two silent spans do not add up against one budget.
deps.onActivity?.(usageBeat(summary.usage, summary.costUsd));

// reactive overflow (was :282-300)
usage.add(summary.usage, summary.costUsd, summary.rates);
deps.onActivity?.(usageBeat(summary.usage, summary.costUsd));

// round trip (was :307-316 and :337-348)
usage.add(res.usage, res.costUsd, res.rates);
// 1-based; `roundTrips` is incremented above, before this beat fires.
deps.onActivity?.(usageBeat(res.usage, res.costUsd, roundTrips));
```

- [ ] **Step 5: Rewire the two readers**

The failure path (`:539-549`) and the result assembly (`:575-585`) both read the counters. Replace with `usage.totals()`:

```typescript
// failure path, inside the outer catch
recordNativeTurnFailureUsage(err, {
  tokenUsage: usage.totals(),
  costUsd: usage.totals().costUsd,
});
```

```typescript
// result assembly
const rates = usage.rates();
return {
  output,
  tokenUsage: usage.totals(),
  estimatedCostUsd: usage.totals().costUsd,
  // ... rest unchanged
```

⚠️ **`recordNativeTurnFailureUsage` takes `tokenUsage` WITHOUT `costUsd` inside it** — check its signature before assuming `totals()` drops in whole. `TurnUsageTotals` includes `costUsd`; if the ledger type excludes it, destructure:

```bash
grep -n "recordNativeTurnFailureUsage" -A 12 src/agents/native/session/turn-types.ts
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean. A failure here is almost always the `usageBeat` return type from Step 3 or the `tokenUsage` shape from Step 5.

- [ ] **Step 7: Run the 14 test files**

```bash
bun test $TURN_TESTS --timeout=30000
```

Expected: PASS, all 14 files. **Any failure means the extraction changed behaviour — fix the source, never the test.**

- [ ] **Step 8: Confirm no test file changed**

```bash
git status --short test/
```

Expected: **empty output.** Non-empty is a stop condition (see Global Constraints).

- [ ] **Step 9: Commit**

```bash
git add src/agents/native/session/turn-accumulator.ts src/agents/native/session/turn-loop.ts
git commit -m "refactor(native): collapse the triplicated turn usage accumulation

The same ten lines accumulated inputTokens, outputTokens, the two cache
counters, costUsd and rateTotals after a proactive compaction summary, after a
reactive overflow summary, and after each round trip. A fourth copy was one
loop event away.

createTurnAccumulator holds the six counters; usageBeat stays a separate
function because the round-trip beat carries roundTrip and the two summary
beats do not. No behaviour change."
```

---

### Task 2: Extract the ask_human branch

**Files:**
- Create: `src/agents/native/session/turn-ask-human.ts`
- Modify: `src/agents/native/session/turn-loop.ts:373-408` (the `if (call.name === ASK_HUMAN_TOOL_NAME)` block)

**Interfaces:**
- Consumes: `buildToolResult` from `./tool-result`, `InteractionExchange` from `@/agents/session-types`, `SendTurnOpts["interactionHandler"]`
- Produces: `handleAskHumanCall(args): Promise<AskHumanOutcome>` where

```typescript
export interface AskHumanOutcome {
  /** Appended to the message array by the caller. */
  readonly result: ToolResultMessage;
  /** Present only when a real exchange happened; the caller pushes it. */
  readonly exchange?: InteractionExchange;
}
```

This task is first among the code moves because the branch is already self-contained: it touches only `interactions`, `maxInteractions`, `roundTrips` and `opts.interactionHandler`, and it deliberately fires no loop events.

- [ ] **Step 1: Read the branch being moved**

```bash
sed -n '373,408p' src/agents/native/session/turn-loop.ts
```

Note the three exits, all of which push a tool result and `continue`:
1. budget spent → error result, **does not** consume budget
2. `answer === null` (no operator reachable) → error result, **does not** consume budget and **is not** recorded as an exchange
3. success → records `{turnIndex: roundTrips, question, reply}` and answers

The comment at `:378-382` explains why these push sites fire no `after_tool` event. **Move it verbatim.**

- [ ] **Step 2: Create the module**

```typescript
/**
 * The `ask_human` branch of the turn loop's tool-call batch.
 *
 * Extracted unchanged. It is not an ordinary tool call: no tool produced it,
 * so it deliberately fires no `before_tool`/`after_tool` event — a policy that
 * shapes tool output has nothing to shape here.
 */

import type { InteractionExchange, SendTurnOpts } from "@/agents/session-types";
import { buildToolResult, type ToolResultMessage } from "./tool-result";

export interface AskHumanOutcome {
  readonly result: ToolResultMessage;
  readonly exchange?: InteractionExchange;
}

export async function handleAskHumanCall(args: {
  readonly toolCallId: string;
  readonly question: string;
  readonly interactionsSoFar: number;
  readonly maxInteractions: number;
  readonly roundTrips: number;
  readonly interactionHandler: SendTurnOpts["interactionHandler"];
}): Promise<AskHumanOutcome> {
  const { toolCallId, question, interactionsSoFar, maxInteractions, roundTrips, interactionHandler } = args;

  // An unset budget (maxInteractions undefined -> 0) keeps the tool unadvertised
  // above AND refuses a call made anyway. "No budget configured" must not
  // read as "unlimited" — that inverts the property this budget provides.
  if (interactionsSoFar >= maxInteractions) {
    return {
      result: buildToolResult({
        toolCallId,
        content: "The human Q&A budget for this turn is spent. Proceed on your best judgement.",
        isError: true,
      }),
    };
  }

  const answer = await interactionHandler.onInteraction({ kind: "question", text: question });

  // A null answer means no operator is reachable — run-interaction-handler
  // returns null for kind:"question" when no interactionBridge is
  // configured. That is not an exchange: it must not consume budget and
  // must not be recorded as a question the operator answered with "".
  if (answer === null) {
    return {
      result: buildToolResult({
        toolCallId,
        content: "No human operator is available for this run. Proceed on your best judgement.",
        isError: true,
      }),
    };
  }

  return {
    result: buildToolResult({ toolCallId, content: answer.answer }),
    exchange: { turnIndex: roundTrips, question, reply: answer.answer },
  };
}
```

- [ ] **Step 3: Rewire the call site**

Replace `turn-loop.ts:373-408` with:

```typescript
if (call.name === ASK_HUMAN_TOOL_NAME) {
  const question = String((call.input as { text?: unknown } | undefined)?.text ?? "");
  // These push sites — and the spin notice below — are answers to a call no
  // tool produced. They use the chokepoint and deliberately fire no
  // `after_tool` event: a policy that shapes tool output has nothing to
  // shape here.
  const outcome = await handleAskHumanCall({
    toolCallId: call.id,
    question,
    interactionsSoFar: interactions.length,
    maxInteractions,
    roundTrips,
    interactionHandler: opts.interactionHandler,
  });
  if (outcome.exchange !== undefined) interactions.push(outcome.exchange);
  messages.push(outcome.result);
  continue;
}
```

⚠️ Order matters: the original pushes the exchange **before** the result. Keep that order — a test asserting `interactions` length inside a handler would otherwise observe a different intermediate state.

- [ ] **Step 4: Verify `ToolResultMessage` is exported**

```bash
grep -n "ToolResultMessage" src/agents/native/session/tool-result.ts src/agents/native/session/loop-events.ts
```

It is re-exported from `loop-events.ts:34`. Import it from `./tool-result` directly in the new module — importing through `loop-events` would add a needless edge.

- [ ] **Step 5: Typecheck, test, confirm no test edits**

```bash
bun run typecheck
bun test $TURN_TESTS --timeout=30000
git status --short test/
```

Expected: clean typecheck, all 14 files PASS, empty `git status` for `test/`.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/turn-ask-human.ts src/agents/native/session/turn-loop.ts
git commit -m "refactor(native): extract the ask_human branch from the turn loop

Self-contained already: it touches only the interaction budget, roundTrips and
the interaction handler, and it deliberately fires no before_tool/after_tool
event because no tool produced the call. Moved unchanged, comments included.

No behaviour change."
```

---

### Task 3: Extract the compaction step

**Files:**
- Create: `src/agents/native/session/turn-compaction-step.ts`
- Modify: `src/agents/native/session/turn-loop.ts:155-224` (proactive) and `:275-303` (reactive overflow)

**Interfaces:**
- Consumes: `TurnAccumulator` + `usageBeat` (Task 1); `applyCompaction`, `estimateContextTokens`, `keepBudget`, `prepareCompaction`, `shouldCompact` from `./compaction`
- Produces:

```typescript
export interface CompactionStepResult {
  readonly messages: readonly NativeTranscriptMessage[];
  /** True when the array was rebound, so the caller clears lastUsage/anchorIndex. */
  readonly compacted: boolean;
  /** Proactive only: the summarizer threw, so the overflow retry must not try again. */
  readonly summarizeFailed: boolean;
}

export async function runProactiveCompaction(args): Promise<CompactionStepResult>;
export async function runOverflowCompaction(args): Promise<CompactionStepResult>;
```

**This is the first task where getting it wrong is subtle.** Read spec §5.4 and the two comments at `turn-loop.ts:150-154` and `:300-302` before starting.

- [ ] **Step 1: Read both branches and note the three differences**

```bash
sed -n '150,225p' src/agents/native/session/turn-loop.ts
sed -n '272,305p' src/agents/native/session/turn-loop.ts
```

The two branches differ in exactly three ways, and **all three must survive the extraction**:

1. **Keep budget.** Proactive: `keepBudget(deps.contextWindow, deps.compaction)`. Reactive: `keepBudget(deps.contextWindow, deps.compaction, true)` — the third argument halves it. The comment says "Same code path, half the keep budget. Not a second algorithm."
2. **Failure handling.** Proactive catches a summarizer throw, sets `summarizeFailed = true` and continues uncompacted (unless the deadline expired or the signal aborted, which rethrow). Reactive does **not** catch — `prepareCompaction` returning undefined rethrows the original error, and a summarizer throw propagates.
3. **Progress logging.** Proactive measures `preCompactionTokens`/`postCompactionTokens` and warns when compaction made no progress (Finding 2, whole-branch review 2026-09-04), plus an info log. Reactive logs neither.

- [ ] **Step 2: Create the module with both functions**

Write `runProactiveCompaction` and `runOverflowCompaction` as two exported functions sharing one private helper for the summarize-and-apply core. Both take:

```typescript
{
  messages: readonly NativeTranscriptMessage[];
  usage: TurnAccumulator;
  sessionName: string;
  lastUsage: { promptTokens: number } | undefined;
  anchorIndex: number | undefined;
  deps: Pick<TurnDeps, "summarize" | "contextWindow" | "compaction" | "onActivity" | "deadline">;
  signal?: AbortSignal;
}
```

Move every comment verbatim: the `shouldCompact` bound comment at `:150-154`, the "Rebound, not spliced in place" comment, the Finding 2 comment, the "The anchor described the pre-compaction array" comment, the "Not fatal" comment, and the "Same code path, half the keep budget" comment.

**Do NOT collapse the two functions into one with a boolean flag.** The three differences above are not variations on a parameter — the failure semantics are genuinely different, and a `reactive: boolean` flag would hide that a summarizer throw propagates in one and is swallowed in the other.

- [ ] **Step 3: Rewire the proactive site**

```typescript
let summarizeFailed = false;
if (
  deps.summarize !== undefined &&
  deps.contextWindow !== undefined &&
  deps.compaction !== undefined &&
  shouldCompact(estimateContextTokens(messages, lastUsage, anchorIndex), deps.contextWindow, deps.compaction)
) {
  const step = await runProactiveCompaction({
    messages, usage, sessionName: handle.id, lastUsage, anchorIndex, deps,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  messages = [...step.messages];
  summarizeFailed = step.summarizeFailed;
  if (step.compacted) {
    lastUsage = undefined;
    anchorIndex = undefined;
  }
}
```

⚠️ The guard stays **at the call site**, not inside the function. TypeScript's narrowing of `deps.summarize`/`contextWindow`/`compaction` to defined is what the overflow branch at `:232-241` depends on — the comment at `:230-232` says it is written as one guarded `if` specifically so that narrowing carries. Moving the guard inside would lose it.

- [ ] **Step 4: Rewire the reactive site**

Replace the `else` branch at `:275-303`, keeping the `res = await deps.complete(messages, tools)` retry at the end and the "Retried once" comment.

- [ ] **Step 5: Typecheck, test, confirm no test edits**

```bash
bun run typecheck
bun test $TURN_TESTS --timeout=30000
git status --short test/
```

`turn-loop-compaction.test.ts` is 20.5 KB and is the file most likely to catch a mistake here. Expected: all 14 PASS, empty `git status` for `test/`.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/turn-compaction-step.ts src/agents/native/session/turn-loop.ts
git commit -m "refactor(native): extract proactive and overflow compaction

Both branches move to turn-compaction-step.ts as two functions sharing a
private summarize-and-apply core, deliberately NOT one function with a
reactive flag: the keep budget is halved, the summarizer throw is swallowed in
one and propagates in the other, and only the proactive branch logs progress.
A boolean would hide the failure-semantics difference.

The deps guard stays at the call site so TypeScript's narrowing still reaches
the overflow branch below it. No behaviour change."
```

---

### Task 4: Extract the complete step

**Files:**
- Create: `src/agents/native/session/turn-complete-step.ts`
- Modify: `src/agents/native/session/turn-loop.ts:226-305` (the `try { res = await deps.complete(...) } catch { ... }`)

**Interfaces:**
- Consumes: `runOverflowCompaction` (Task 3), `TurnAccumulator` (Task 1), `retryTransportFault`/`realSleep` from `./turn-retry`, `isContextOverflow` (currently private at `turn-loop.ts:46`)
- Produces:

```typescript
export async function completeWithRecovery(args): Promise<{
  readonly res: NativeTurnResponse;
  readonly messages: readonly NativeTranscriptMessage[];
  readonly compacted: boolean;
}>;
```

**This is the module PR 2 adds `transform_context` and `before_request` to** (spec §6.1), which is the whole reason it becomes one site instead of two. Do not add either event now.

- [ ] **Step 1: Move `isContextOverflow` into the new module**

It is private to `turn-loop.ts` at `:46-50` and used only by this branch. Move it with its docblock ("Structural, matching adapter.ts's guard: nax-ai's error class is not importable here and the kind is what matters."). Keep it unexported unless Task 5 needs it — it does not.

- [ ] **Step 2: Create the module**

The function body is `turn-loop.ts:226-305` with `messages` passed in and returned rather than closed over. Preserve verbatim:
- the "Written as one guarded `if` (not a separate `canRetry` boolean)" comment at `:230-232`
- the nax#1870 comment at `:242-246`
- the whole `onRetry` logger call including the "All-zero is honest, not fabricated" comment
- the "Falls through to the shared round-trip bookkeeping" comment at `:271-275`

⚠️ **The `onRetry` beat is `{kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0}` and must NOT go through `usageBeat`** — `usageBeat` calls `cacheUsageFields(usage)` and there is no usage object here. The comment explains the all-zero is deliberate. Emit the literal as-is.

- [ ] **Step 3: Rewire the call site**

```typescript
const step = await completeWithRecovery({
  messages, tools, usage, summarizeFailed, sessionName: handle.id, deps,
  ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
});
const res = step.res;
messages = [...step.messages];
if (step.compacted) {
  lastUsage = undefined;
  anchorIndex = undefined;
}
```

⚠️ `res` is declared `let res: NativeTurnResponse;` at `:226` and assigned in three places. After extraction it is a `const` from one return. Confirm nothing below `:305` reassigns it:

```bash
awk 'NR>305 && /res *=[^=]/' src/agents/native/session/turn-loop.ts
```

Expected: no output.

- [ ] **Step 4: Typecheck, test, confirm no test edits**

```bash
bun run typecheck
bun test $TURN_TESTS --timeout=30000
git status --short test/
```

`turn-loop-transport-retry.test.ts` (20.4 KB) is the discriminator here. Expected: all 14 PASS, empty `git status` for `test/`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-complete-step.ts src/agents/native/session/turn-loop.ts
git commit -m "refactor(native): extract the complete-with-recovery step

deps.complete plus its two recoveries — transport-fault retry and
context-overflow compaction — move to one module, along with the private
isContextOverflow guard they share. This is the single site P3's
transform_context and before_request will dispatch from; today it is two.

The onRetry all-zero usage beat stays a literal rather than going through
usageBeat: there is no usage object to derive cache fields from, and the
all-zero is deliberate (a pre-first-event transport throw bills nothing).
No behaviour change."
```

---

### Task 5: Extract the tool batch

**Files:**
- Create: `src/agents/native/session/turn-tool-batch.ts`
- Modify: `src/agents/native/session/turn-loop.ts:362-524` (the `for (const [callIndex, call] of res.toolCalls.entries())` loop)

**Interfaces:**
- Consumes: `handleAskHumanCall` (Task 2), `loopEvents` registry, `invalidCallBudget`, `spinBreaker`, `truncateNativeToolResult`, `rewriteToolCallInput`, `buildToolResult`, `nudgeOverheadBytes`/`withNudge`
- Produces:

```typescript
export interface ToolBatchResult {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly interactions: readonly InteractionExchange[];
  readonly codingToolsCalled: readonly string[];
  /** The caller breaks out of the while loop on either. */
  readonly spinStopped: boolean;
  readonly budgetExceeded: boolean;
}

export async function runToolBatch(args): Promise<ToolBatchResult>;
```

This is the largest move (~162 lines) and the one with the most invariants. **Read the whole region before editing anything.**

- [ ] **Step 1: Read the region and list the six exits**

```bash
sed -n '362,525p' src/agents/native/session/turn-loop.ts
```

The batch loop has six ways a call is answered, each with a distinct rule:
1. `spinWarned` already set → `spinStopped = true`, `break`, **no result pushed** (the terminal round trip is answer-only; a later call is neither executed nor answered)
2. `ask_human` → Task 2's handler
3. `invalidCallBudget.exceeded` after `beforeTool` → `break` with **NO result** (nax#2047 Task 4: "a result nobody reads only grows the transcript"). **Checked before the outcome is applied.**
4. `outcome.kind === "terminate"` → answers **every outstanding call** in the batch via `res.toolCalls.slice(callIndex)`, then `break` (nax#2120: a batch left with an unanswered `tool_call` is rejected by strict providers)
5. `outcome.kind === "block"` → records a corrected input if present, answers on the tool's behalf, `continue`
6. genuine execution → `after_tool`, truncation, nudge, push

Plus the `catch` at `:505-522`: a tool throw fires `after_tool` too, because a policy bounding result size has to see error results.

- [ ] **Step 2: Note the two traps carried in comments**

Both are load-bearing and both must survive verbatim:

- **`input` MUST be `input`, not `call.input`** at the coding-tool dispatch (`:459-467`). The comment spells out the failure: `before_tool`'s `allow` may rewrite the input, `rewriteToolCallInput` has already recorded the corrected value, and using `call.input` makes execution and transcript diverge silently with no test covering it.
- **`spinBreaker?.noteResult(call.name, input, answerText)`** uses the same rewritten `input` (`:500-504`), or the key misses and result-based repetition detection stops for rewritten calls.

- [ ] **Step 3: Create the module**

Move the loop verbatim into `runToolBatch`, taking `res.toolCalls`, `tools`, `codingToolNames`, `roundTrips`, `handle.id`, `opts`, `deps`, `loopEvents`, `invalidCallBudget`, `spinBreaker`, and the current `messages`. Accumulate `interactions` and `codingToolsCalled` locally and return them rather than mutating caller arrays.

`spinWarned` is set by the spin breaker's `onSpinStop` callback, which is registered on the loop-event registry in `turn-loop.ts:121-127` — it stays there. Pass the **current value** in and return `spinStopped` out.

- [ ] **Step 4: Rewire the call site**

```typescript
const batch = await runToolBatch({ /* ... */ });
messages = [...batch.messages];
interactions.push(...batch.interactions);
codingToolsCalled.push(...batch.codingToolsCalled);
if (batch.spinStopped) spinStopped = true;
if (batch.spinStopped) break;
if (batch.budgetExceeded) break;
```

⚠️ The original checks `if (spinStopped) break;` then `if (invalidCallBudget.exceeded) break;` at `:525-526`, **after** the for loop. Preserve both and their order.

- [ ] **Step 5: Typecheck, test, confirm no test edits**

```bash
bun run typecheck
bun test $TURN_TESTS --timeout=30000
git status --short test/
```

Four files matter most here: `turn-loop-seam.test.ts`, `turn-loop-seam-regressions.test.ts`, `session-lifetime-spin.test.ts` and `native-truncation-nudge.test.ts`. Expected: all 14 PASS, empty `git status` for `test/`.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/turn-tool-batch.ts src/agents/native/session/turn-loop.ts
git commit -m "refactor(native): extract the tool-call batch loop

The largest of the turn-loop extractions. All six answer paths move unchanged:
the spin-stopped skip that pushes no result, ask_human, the invalid-call budget
halt that deliberately answers nothing (nax#2047), the batch-level terminate
that answers every outstanding call (nax#2120), block, and genuine execution.

Both input-identity traps are preserved with their comments: the coding-tool
dispatch uses the possibly-rewritten input rather than call.input, and
spinBreaker.noteResult keys on that same value. No behaviour change."
```

---

### Task 6: Extract the result assembly

**Files:**
- Create: `src/agents/native/session/turn-result.ts`
- Modify: `src/agents/native/session/turn-loop.ts:553-599` (the two tail warnings and the return)

**Interfaces:**
- Consumes: `TurnAccumulator` (Task 1)
- Produces: `buildTurnResult(args): TurnResult` and `logTurnTailWarnings(args): void`

⚠️ **Name collision check:** a `tool-result.ts` already exists in this directory exporting `buildToolResult`. `turn-result.ts` / `buildTurnResult` is close enough to misread. Before creating it, confirm no `turn-result.ts` exists:

```bash
ls src/agents/native/session/ | grep -i result
```

Expected: `tool-result.ts` only. If the similarity feels too high during implementation, `turn-result-builder.ts` is an acceptable alternative — say so in the commit rather than renaming silently.

- [ ] **Step 1: Read the tail**

```bash
sed -n '550,599p' src/agents/native/session/turn-loop.ts
```

Two warnings — `!completedNormally` (with its acp/adapter.ts:555 parity comment) and `spinStopped` — then `saveTranscript`, then the return with eight conditional spreads.

- [ ] **Step 2: Create the module**

`logTurnTailWarnings({ sessionName, completedNormally, spinStopped, roundTrips, timedOut, spinBreaker })` and `buildTurnResult({ output, usage, roundTrips, codingTools, codingToolsCalled, completedNormally, timedOut, spinStopped, budgetExceeded, interactions, pricingSource })`.

Keep all eight conditional spreads exactly as written. The `...(completedNormally ? {} : { turnIncomplete: true })` inversion is easy to get backwards — it sets the flag when the turn did **not** complete.

- [ ] **Step 3: Rewire, leaving `saveTranscript` in place**

`saveTranscript` stays in `turn-loop.ts`, between the warnings and the return. Its comment says a write failure **fails the turn** here, unlike the best-effort save in the catch — that distinction belongs with the control flow, not in a result builder.

- [ ] **Step 4: Typecheck, test, confirm no test edits**

```bash
bun run typecheck
bun test $TURN_TESTS --timeout=30000
git status --short test/
```

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-result.ts src/agents/native/session/turn-loop.ts
git commit -m "refactor(native): extract the turn result assembly and tail warnings

saveTranscript deliberately stays in turn-loop.ts between the two: a write
failure there fails the turn, unlike the best-effort save in the catch, and
that distinction belongs with the control flow. No behaviour change."
```

---

### Task 7: Final verification

**Files:** none modified — this task only verifies.

- [ ] **Step 1: Confirm the line budget**

```bash
wc -l src/agents/native/session/turn-*.ts
bun run scripts/check-file-sizes.ts
```

Expected: `turn-loop.ts` around 200-250 lines, every new module well under 600, and the check script reporting the **same baseline of 13 grandfathered files** as before — not 14. A new oversized file means an extraction was too coarse.

- [ ] **Step 2: Confirm the export surface did not widen**

```bash
grep -n "^export" src/agents/native/session/turn-loop.ts
```

Expected: exactly `export async function runNativeTurn` and nothing else. The whole proof obligation rests on this file having one export (spec §5.5).

- [ ] **Step 3: Confirm ZERO test files changed across the entire PR**

```bash
git diff --name-only main...HEAD -- test/
```

Expected: **empty output.** This is the PR's headline claim; verify it once at the end as well as per-task.

- [ ] **Step 4: Run the full suite**

```bash
bun run test
```

Expected: green. The 14 targeted files have passed at every step, but only the full suite catches a module this refactor broke indirectly.

- [ ] **Step 5: Run all static gates**

```bash
bun run typecheck
bun run lint
```

Expected: green, including `check:import-cycles` at baseline 0 — six new modules in one directory is exactly where a cycle would appear (`turn-complete-step` imports `turn-compaction-step`; nothing may import back into `turn-loop`).

- [ ] **Step 6: Check coverage did not regress**

```bash
bun run test:coverage
```

`test:coverage` is a separate CI step with a per-file floor and is **not** part of the nax pipeline. New files with no direct tests can fail the per-file gate even though the suite is green. If it fails: **do not add tests to satisfy it in this PR** — that would break the no-test-edits claim. Report the failure and treat the baseline update as a decision for the reviewer.

- [ ] **Step 7: Open the PR**

Title: `refactor(native): extract turn-loop.ts ahead of the P3 loop events`

Body must state: zero behaviour change; zero test edits (with the `git diff --name-only` output as evidence); the before/after line counts; that this is PR 1 of 3 for P3; and a link to `docs/superpowers/specs/2026-09-22-p3-loop-events-design.md`.

**Run a code review before pushing, never after** (standing rule).

---

## Self-Review

**Spec coverage (§5):** §5.1 (one dispatch site per event) → Task 4 collapses the two `deps.complete` sites, Task 3 the two compaction sites. §5.2 (17 mutable locals) → Task 1 removes six. §5.3 (the unlock) → Task 1. §5.4 (carve-up, six modules) → Tasks 1-6, one per row of the table. §5.5 (proof obligation) → per-task Step "confirm no test edits" plus Task 7 Step 3. **No gap.**

**Out of scope, correctly absent:** no task adds an event, the async registry, or the cache-boundary checker — those are PR 2 (spec §10). Task 4 notes where PR 2 will attach without attaching anything.

**Type consistency:** `TurnAccumulator` is produced in Task 1 and consumed by name in Tasks 3, 4 and 6. `handleAskHumanCall` is produced in Task 2 and consumed in Task 5. `runOverflowCompaction` is produced in Task 3 and consumed in Task 4. `ToolResultMessage` is imported from `./tool-result` in both Task 2 and Task 5. No name drifts between tasks.

**Known soft spots, flagged rather than hidden:** Task 1 Step 3 (`usageBeat`'s real return type) and Task 1 Step 5 (`recordNativeTurnFailureUsage`'s `tokenUsage` shape) are the two places the plan tells the implementer to check the real type rather than trust the plan's guess, because both are inferred from call sites rather than read from a declaration. Task 6 carries a name-collision check against the existing `tool-result.ts`.
