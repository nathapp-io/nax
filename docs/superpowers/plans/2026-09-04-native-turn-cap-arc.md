# Native Turn-Cap Arc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace native's silent round-trip cap with time-based guards at parity with acpx, and make a truncated turn a first-class, correctly-classified outcome.

**Architecture:** `timeoutSeconds` already flows to the native adapter but is spent inside each `complete()` call, so every round-trip gets a fresh full budget. We hoist it to turn scope via a shared `TurnDeadline` helper used by both transports, teach the native loop to report two transport facts (`timedOut`, `turnIncomplete`), fix the classifier to consult those facts before its non-empty-output short-circuit, give native the stream events the idle watchdog needs, and only then delete the round-trip cap. `agent.maxInteractionTurns` keeps its documented meaning and starts bounding a real native human-Q&A path.

**Tech Stack:** TypeScript, Bun (test runner + bundler), Biome (lint/format), Zod (config schemas), `@nathapp/nax-ai` (native provider client).

**Spec:** `docs/superpowers/specs/2026-09-04-native-turn-cap-arc-design.md`

## Global Constraints

- **Branch:** all work lands on `feat/native-turn-cap-arc`. Verify with `git branch --show-current` before the first commit of every task.
- **Full test suite is `bun run test`. NEVER bare `bun test` for the suite** — it bypasses `scripts/run-tests.ts` and invents failures. Iterating on a single file with `bun test <path> --timeout=5000` is fine and is what the TDD steps below use; the pre-commit gate is always `bun run test`.
- **File-size gate (`bun run check:file-sizes`), SRC limit 600 / TEST limit 800.** A file already in `scripts/baselines/file-sizes-baseline.json` may not grow by even one line; there is no raise path. Relevant current sizes: `src/session/manager.ts` **744, baselined — must not grow**; `src/agents/acp/adapter.ts` **593, not baselined — 7 lines of headroom before it becomes a new violation**; `src/agents/native/session/turn-loop.ts` 148; `src/agents/native/adapter.ts` 225; `src/runtime/index.ts` 418; `test/unit/agents/native/turn-loop.test.ts` 306.
- **Biome re-wraps on format, so a "shorter" edit can cost lines.** Always run `bun x biome check --write <file>` **then** `grep -c '' <file>` — never trust a pre-format count.
- **Lint gate is `bun run lint`** and includes `check:file-sizes`, `check:import-cycles`, `check:nax-error`, `check:logger-storyid` among others. Run it before every commit.
- **Typecheck is `bun run typecheck`** (covers `tsconfig.json` and `tsconfig.test.json`).
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). No emojis in code, comments, or commit messages.
- **A regression test must make BOTH sides non-empty.** Every gate below is verified by *reintroducing* the bug and confirming the test fails. A test that passes under both the old and new behaviour proves nothing.
- **No new config key.** `execution.sessionTimeoutSeconds` (default 3600) and `agent.maxInteractionTurns` (default 20) are the only knobs involved, and neither changes its default or its name.

---

## File Structure

**Created:**
- `src/agents/turn-deadline.ts` — shared whole-turn wall-clock budget, transport-agnostic. Consumed by both the native turn loop and the ACP adapter. Small and pure so both transports can test it in isolation.
- `src/agents/native/session/turn-events.ts` — builds `AgentStreamEvent` objects for the native loop. Kept out of `turn-loop.ts` so the loop stays about control flow and the loop file stays well under 600.
- `src/agents/native/session/ask-human.ts` — the ask-human tool definition and the reserved tool name.
- `test/unit/agents/turn-deadline.test.ts`
- `test/unit/agents/native/turn-events.test.ts`

**Modified:**
- `src/agents/session-types.ts` (210) — add `TurnResult.turnIncomplete`.
- `src/agents/native/session/turn-loop.ts` (148) — deadline checks, transport facts, warn, activity emission, counter split, ask-human routing.
- `src/agents/native/adapter.ts` (225) — own the turn deadline and turn-level `AbortController`, register `onActiveCall`, wire `onStreamActivity`.
- `src/agents/native/session/session.ts` (68) — store the per-session `onStreamActivity` / `onActiveCall` callbacks alongside `nativeSessionTimeouts`.
- `src/agents/acp/adapter.ts` (593, tight) — adopt the shared deadline. Net line count must not exceed 600.
- `src/operations/turn-failure-classification.ts` (79) — branch reordering.
- `src/runtime/index.ts` (418) — backfill `runId` on forwarded stream events.
- `test/unit/agents/native/turn-loop.test.ts` (306), `test/unit/operations/turn-failure-classification.test.ts`.

---

### Task 1: Native reports transport facts and warns at cap exit

Implements spec story S1. Adds the two facts nothing downstream can currently see, without changing any behaviour. Landable alone.

**Files:**
- Modify: `src/agents/session-types.ts` (add `turnIncomplete` to `TurnResult`)
- Modify: `src/agents/native/session/turn-loop.ts`
- Test: `test/unit/agents/native/turn-loop.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TurnResult.turnIncomplete?: boolean` — true when the loop exited while the model still had unexecuted tool calls pending. Tasks 3, 4 and 5 depend on this exact field name and meaning.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/turn-loop.test.ts`, inside the existing `describe("native turn loop", ...)` block:

```ts
  test("flags an incomplete turn when the cap cuts the loop off mid-work", async () => {
    // Every completion asks for another tool, so the loop can only end at the cap.
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 3 }), {
      complete: async () => reply({ text: "still working on it", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] }),
    });
    // Both sides non-empty: output IS present, which is exactly why this case
    // slipped past the empty-output guard.
    expect(result.output).toBe("still working on it");
    expect(result.internalRoundTrips).toBe(3);
    expect(result.turnIncomplete).toBe(true);
  });

  test("a turn that ends on its own is not flagged incomplete", async () => {
    const result = await runNativeTurn(handle, "hi", opts(), { complete: async () => reply() });
    expect(result.output).toBe("done");
    expect(result.turnIncomplete).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: FAIL — `expected true, got undefined` on `result.turnIncomplete`. The second test passes already; that is intended, it is the control.

- [ ] **Step 3: Add the field to `TurnResult`**

In `src/agents/session-types.ts`, add immediately after the `timedOut` field's declaration:

```ts
  /**
   * Transport fact: the loop returned while the model still had tool calls
   * pending — it asked for work that was never executed and never answered.
   *
   * Defined by the condition, not by enumerating exits, so its meaning is
   * stable as the exits change: today the round-trip cap, the whole-turn
   * deadline and an abort can all produce it; once the cap is removed only the
   * deadline and abort can. Like `timedOut`, the adapter never classifies WHY —
   * the wiring layer does (see operations/turn-failure-classification.ts).
   */
  turnIncomplete?: boolean;
```

- [ ] **Step 4: Set the fact and warn in the native loop**

In `src/agents/native/session/turn-loop.ts`, add the logger import next to the existing imports:

```ts
import { getSafeLogger } from "@/logger";
```

Replace the loop-exit bookkeeping. Declare alongside the other accumulators (near `let output = "";`):

```ts
  // Set ONLY on the clean exit — the model returned no further tool calls.
  // Every other way out of the loop (today the cap; later the deadline or an
  // abort) leaves work the model asked for unexecuted.
  let completedNormally = false;
```

Replace the clean-exit line inside the loop:

```ts
    if (res.toolCalls === undefined || res.toolCalls.length === 0) break;
```

with:

```ts
    if (res.toolCalls === undefined || res.toolCalls.length === 0) {
      completedNormally = true;
      break;
    }
```

After the `while` loop, before `await saveTranscript(...)`, add:

```ts
  // Parity with acp/adapter.ts:555, which warns in exactly this situation. A
  // native turn that stops here is indistinguishable from a finished one
  // without this line plus the `turnIncomplete` fact below.
  if (!completedNormally) {
    getSafeLogger()?.warn("native-adapter", "turn ended with tool calls outstanding", {
      sessionName: handle.id,
      roundTrips,
      maxTurns,
    });
  }
```

and add the field to the returned object, after `internalRoundTrips: roundTrips,`:

```ts
    ...(completedNormally ? {} : { turnIncomplete: true }),
```

The flag is deliberately inverted rather than tracking "pending". A flag that flips back
to `false` after each tool batch finishes executing would read `false` at a cap exit —
exactly the case this fact exists to catch — and Step 6's gate would then pass vacuously.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Verify the gate by reintroducing the bug**

Temporarily delete the `...(completedNormally ? {} : { turnIncomplete: true }),` line and re-run the file.
Expected: FAIL on `flags an incomplete turn...` only. Restore the line and confirm PASS again. If the test still passes with the line removed, the test is worthless — fix it before continuing.

- [ ] **Step 7: Format, size-check, lint and typecheck**

```bash
bun x biome check --write src/agents/native/session/turn-loop.ts src/agents/session-types.ts test/unit/agents/native/turn-loop.test.ts
grep -c '' src/agents/native/session/turn-loop.ts src/agents/session-types.ts test/unit/agents/native/turn-loop.test.ts
bun run typecheck && bun run lint
```

Expected: turn-loop.ts well under 600, the test file well under 800, lint and typecheck clean.

- [ ] **Step 8: Run the full suite**

Run: `bun run test`
Expected: PASS. (Not `bun test` — see Global Constraints.)

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must be feat/native-turn-cap-arc
git add src/agents/session-types.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop.test.ts
git commit -m "feat(native): report turnIncomplete and warn when a turn is cut off (#1819)"
```

---

### Task 2: Whole-turn deadline on both transports

Implements spec story S2. The deadline must exist before the cap is removed in Task 5, because the cap is today's only incidental duration bound.

**Files:**
- Create: `src/agents/turn-deadline.ts`
- Create: `test/unit/agents/turn-deadline.test.ts`
- Modify: `src/agents/native/session/turn-loop.ts`
- Modify: `src/agents/native/adapter.ts:184-217`
- Modify: `src/agents/acp/adapter.ts` (**593 lines, 7 to spare — this task must not push it past 600**)
- Test: `test/unit/agents/native/turn-loop.test.ts`

**Interfaces:**
- Consumes: `TurnResult.turnIncomplete` from Task 1.
- Produces:
  - `createTurnDeadline(timeoutSeconds: number | undefined, now?: () => number): TurnDeadline`
  - `interface TurnDeadline { remainingMs(): number | undefined; expired(): boolean }`
  - `TurnDeps.deadline?: TurnDeadline` — the native loop consults it each iteration. Task 4 adds a sibling field to the same interface.

- [ ] **Step 1: Write the failing test for the helper**

Create `test/unit/agents/turn-deadline.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTurnDeadline } from "@/agents/turn-deadline";

describe("turn deadline", () => {
  test("an undefined budget never expires and reports no remainder", () => {
    const d = createTurnDeadline(undefined, () => 0);
    expect(d.expired()).toBe(false);
    expect(d.remainingMs()).toBeUndefined();
  });

  test("counts down from the clock it was created against", () => {
    let now = 1_000;
    const d = createTurnDeadline(10, () => now);
    expect(d.remainingMs()).toBe(10_000);
    now = 4_000;
    expect(d.remainingMs()).toBe(7_000);
    expect(d.expired()).toBe(false);
  });

  test("expires once the budget is spent and never reports a negative remainder", () => {
    let now = 0;
    const d = createTurnDeadline(5, () => now);
    now = 5_000;
    expect(d.expired()).toBe(true);
    now = 9_999;
    expect(d.remainingMs()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/turn-deadline.test.ts --timeout=5000`
Expected: FAIL — cannot resolve module `@/agents/turn-deadline`.

- [ ] **Step 3: Write the helper**

Create `src/agents/turn-deadline.ts`:

```ts
/**
 * A whole-turn wall-clock budget, shared by both transports.
 *
 * `timeoutSeconds` has always meant "per agent coding session"
 * (config-descriptions.ts, execution.sessionTimeoutSeconds, default 3600) and
 * acpx spends it that way. Native spent it per LLM call instead, so a turn's
 * real bound was `maxTurns x timeoutSeconds` — a product nobody intended. This
 * type exists so one budget can be created once per turn and consulted by
 * every round-trip inside it.
 */

export interface TurnDeadline {
  /** Milliseconds left, clamped at 0. `undefined` when the turn is unbounded. */
  remainingMs(): number | undefined;
  /** True once the budget is spent. Always false for an unbounded turn. */
  expired(): boolean;
}

const UNBOUNDED: TurnDeadline = {
  remainingMs: () => undefined,
  expired: () => false,
};

export function createTurnDeadline(
  timeoutSeconds: number | undefined,
  now: () => number = Date.now,
): TurnDeadline {
  if (timeoutSeconds === undefined) return UNBOUNDED;
  const endsAt = now() + timeoutSeconds * 1000;
  return {
    remainingMs: () => Math.max(0, endsAt - now()),
    expired: () => now() >= endsAt,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/unit/agents/turn-deadline.test.ts --timeout=5000`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the native loop honouring the deadline**

Append to `test/unit/agents/native/turn-loop.test.ts`:

```ts
  test("stops on the whole-turn deadline and reports it as a transport fact", async () => {
    let now = 0;
    const deadline = createTurnDeadline(30, () => now);
    let calls = 0;
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 50 }), {
      deadline,
      complete: async () => {
        calls += 1;
        now += 20_000; // two round-trips fit; the third must not start
        return reply({ text: "partial progress", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] });
      },
    });
    expect(calls).toBe(2);
    expect(result.timedOut).toBe(true);
    expect(result.turnIncomplete).toBe(true);
    // Non-empty on both sides: the budget ran out mid-work, with prose present.
    expect(result.output).toBe("partial progress");
  });

  test("an unbounded turn is never stopped by the deadline", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "hi", opts({ maxTurns: 5 }), {
      complete: async () => {
        round += 1;
        return round < 3
          ? reply({ text: "working", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] })
          : reply({ text: "finished" });
      },
    });
    expect(result.output).toBe("finished");
    expect(result.timedOut).toBeUndefined();
  });
```

Add to that file's imports:

```ts
import { createTurnDeadline } from "@/agents/turn-deadline";
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: FAIL — `deadline` is not a known property of `TurnDeps`, and `result.timedOut` is `undefined`.

- [ ] **Step 7: Teach the native loop the deadline**

In `src/agents/native/session/turn-loop.ts`, add to the imports:

```ts
import type { TurnDeadline } from "@/agents/turn-deadline";
```

Extend `TurnDeps`:

```ts
export interface TurnDeps {
  complete(
    messages: readonly ConversationMessage[],
    tools: ReturnType<typeof toToolDefinitions>,
  ): Promise<NativeTurnResponse>;
  /**
   * Whole-turn wall-clock budget. Absent means unbounded — the adapter always
   * supplies one for a real session; tests may omit it.
   */
  deadline?: TurnDeadline;
}
```

Declare the fact alongside `completedNormally`:

```ts
  let timedOut = false;
```

Add the check as the first statement inside the `while` body, before `const res = await deps.complete(...)`:

```ts
    // Checked before starting a round-trip rather than after finishing one:
    // starting a call we know cannot finish inside the budget spends money for
    // an answer we will discard.
    if (deps.deadline?.expired() === true) {
      timedOut = true;
      break;
    }
```

Include it in the warn context and the result. Change the warn call's object to:

```ts
    getSafeLogger()?.warn("native-adapter", "turn ended with tool calls outstanding", {
      sessionName: handle.id,
      roundTrips,
      maxTurns,
      timedOut,
    });
```

and add to the returned object, next to the `turnIncomplete` spread:

```ts
    ...(timedOut ? { timedOut: true } : {}),
```

- [ ] **Step 8: Run it to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 9: Hoist the deadline in the native adapter**

In `src/agents/native/adapter.ts`, add to the imports:

```ts
import { createTurnDeadline } from "@/agents/turn-deadline";
```

In `sendTurn`, replace the whole `return runNativeTurn(...)` block (currently `adapter.ts:184-217`) with:

```ts
    // One budget for the whole turn, not one per round-trip. Created here
    // because this is where `timeoutSeconds` is known; consulted by the loop.
    const deadline = createTurnDeadline(timeoutSeconds);

    return runNativeTurn(handle, prompt, opts, {
      deadline,
      complete: async (messages, tools) => {
        // The controller is armed with what is LEFT of the turn, so N
        // round-trips can no longer add up to N x timeoutSeconds. Still
        // combined with any caller-supplied opts.signal via AbortSignal.any so
        // either can end the call.
        const remainingMs = deadline.remainingMs();
        const controller = new AbortController();
        const timer = remainingMs !== undefined ? setTimeout(() => controller.abort(), remainingMs) : undefined;
        const signal =
          opts.signal !== undefined ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;

        try {
          const res = await client.complete(resolved, {
            messages,
            ...(tools.length > 0 ? { tools } : {}),
            sessionId,
            signal,
          });
          const usage = toNaxTokenUsage(res.usage);
          return {
            text: res.text,
            ...(res.toolCalls !== undefined ? { toolCalls: res.toolCalls } : {}),
            ...(res.thinking !== undefined ? { thinking: res.thinking } : {}),
            usage,
            costUsd: estimateCostUsd(usage, rates),
          };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    });
```

- [ ] **Step 10: Adopt the shared deadline in the ACP adapter**

`src/agents/acp/adapter.ts` is at 593 of a 600 limit, so this step must be net-neutral or negative. Add the import:

```ts
import { createTurnDeadline } from "../turn-deadline";
```

In `sendTurn`, immediately after `const MAX_TURNS = opts.maxTurns ?? 10;` add:

```ts
    const turnDeadline = createTurnDeadline(timeoutSeconds);
```

Replace the existing per-iteration call:

```ts
      const turnResult = await runSessionPrompt(impl._session, currentPrompt, timeoutSeconds * 1000, signal);
```

with one that passes what remains of the turn rather than a fresh full budget:

```ts
      const turnResult = await runSessionPrompt(impl._session, currentPrompt, turnDeadline.remainingMs() ?? 0, signal);
```

and add the pre-flight check as the first statement inside the `while` body, before `turnCount++`:

```ts
      if (turnDeadline.expired()) {
        timedOut = true;
        getSafeLogger()?.warn("acp-adapter", "wall-clock timeout exceeded — session terminated", {
          sessionName,
          timeoutSeconds,
        });
        break;
      }
```

- [ ] **Step 11: Pay for the ACP growth**

The previous step adds roughly 9 lines to a file with 7 to spare. Offset it inside the same file — the duplicated warn is now the obvious candidate, since the identical `getSafeLogger()?.warn("acp-adapter", "wall-clock timeout exceeded — session terminated", { sessionName, timeoutSeconds })` block appears both in the new pre-flight check and in the existing `if (turnResult.timedOut)` branch. Extract it once, above `sendTurn`:

```ts
function warnWallClockTimeout(sessionName: string, timeoutSeconds: number): void {
  // Explicit log to distinguish wall-clock timeout from idle watchdog (fail-stale).
  getSafeLogger()?.warn("acp-adapter", "wall-clock timeout exceeded — session terminated", {
    sessionName,
    timeoutSeconds,
  });
}
```

and call `warnWallClockTimeout(sessionName, timeoutSeconds);` from both sites, deleting the two inline blocks and the now-redundant comment on the original.

Then confirm the count, remembering that Biome re-wrapping can cost lines:

```bash
bun x biome check --write src/agents/acp/adapter.ts
grep -c '' src/agents/acp/adapter.ts
```

Expected: **600 or fewer.** If it is over, do not shave rationale comments — find another real duplication in the file to collapse, or move `warnWallClockTimeout` into a sibling module and import it.

- [ ] **Step 12: Verify the gate by reintroducing the bug**

Temporarily restore the native adapter's timer to the full budget (`timeoutSeconds * 1000` in place of `remainingMs`) and re-run:

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: the deadline test still passes, because the loop-level check is what stops it. That is correct but insufficient — so also temporarily delete the `if (deps.deadline?.expired() === true)` block and re-run.
Expected: FAIL on `stops on the whole-turn deadline...` with `calls` reaching 50 instead of 2. Restore both.

- [ ] **Step 13: Format, size-check, lint, typecheck, full suite**

```bash
bun x biome check --write src/agents/turn-deadline.ts src/agents/native/adapter.ts src/agents/acp/adapter.ts src/agents/native/session/turn-loop.ts test/unit/agents/turn-deadline.test.ts test/unit/agents/native/turn-loop.test.ts
grep -c '' src/agents/acp/adapter.ts src/agents/native/adapter.ts src/agents/native/session/turn-loop.ts
bun run typecheck && bun run lint && bun run test
```

Expected: `acp/adapter.ts` at 600 or below, `check:file-sizes` clean, full suite PASS.

- [ ] **Step 14: Commit**

```bash
git add src/agents/turn-deadline.ts test/unit/agents/turn-deadline.test.ts src/agents/native/adapter.ts src/agents/acp/adapter.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop.test.ts
git commit -m "feat(agents): bound a whole turn, not each round-trip, on both transports (#1822)"
```

---

### Task 3: Classifier consults transport facts before the output short-circuit

Implements spec story S3. This is the change that actually closes the silent class, and it deliberately alters acpx behaviour too.

**Files:**
- Modify: `src/operations/turn-failure-classification.ts:27-48`
- Test: `test/unit/operations/turn-failure-classification.test.ts`

**Interfaces:**
- Consumes: `TurnResult.turnIncomplete` (Task 1), `TurnResult.timedOut` (pre-existing, now set by native as of Task 2).
- Produces: `classifyEmptyOutputFailure` keeps its signature `(turn: TurnResult) => AdapterFailure | null`. New failure shape for an incomplete turn: `{ category: "quality", outcome: "fail-quality", retriable: true, reason: "turn-incomplete" }`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/operations/turn-failure-classification.test.ts` (match the file's existing import of `classifyEmptyOutputFailure` and its `TurnResult` fixture style):

The file already has a `makeTurnResult(overrides)` helper and groups tests in `describe`
blocks; use both rather than raw object literals. Add a new block at the end:

```ts
describe("classifyEmptyOutputFailure — transport facts outrank non-empty output", () => {
  test("a timed-out turn WITH prose is a failure, not a success", () => {
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({
        output: "All green. Let me verify the final state of the file:",
        internalRoundTrips: 4,
        timedOut: true,
      }),
    );
    expect(failure).not.toBeNull();
    expect(failure?.outcome).toBe("fail-timeout");
    expect(failure?.reason).toBe("wall-clock-timeout");
  });

  test("an incomplete turn WITH prose classifies as quality, never fail-stale", () => {
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({ output: "still working on it", internalRoundTrips: 10, turnIncomplete: true }),
    );
    expect(failure?.category).toBe("quality");
    expect(failure?.outcome).toBe("fail-quality");
    expect(failure?.reason).toBe("turn-incomplete");
  });

  test("a complete turn with output is still a success", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ output: "done", internalRoundTrips: 2 }));
    expect(failure).toBeNull();
  });

  test("an existing adapterFailure still wins over both facts", () => {
    const existing = { category: "availability", outcome: "fail-quota", retriable: true, message: "m" } as const;
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({ output: "text", timedOut: true, adapterFailure: existing }),
    );
    expect(failure).toBe(existing);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/operations/turn-failure-classification.test.ts --timeout=5000`
Expected: FAIL on the first two — both currently return `null` because the non-empty-output branch short-circuits above the fact checks. The third passes; it is the control that proves the fix does not over-fire.

- [ ] **Step 3: Reorder the branches**

In `src/operations/turn-failure-classification.ts`, replace the body of `classifyEmptyOutputFailure` with:

```ts
export function classifyEmptyOutputFailure(turn: TurnResult): AdapterFailure | null {
  if (turn.adapterFailure) return turn.adapterFailure;

  // Transport facts are consulted BEFORE the output check. A turn that ran out
  // of budget mid-work almost always has prose in `output`, so short-circuiting
  // on "output is non-empty" classified the common truncation case as a clean
  // success — the defect that hid it for 44% of native run calls.
  if (turn.timedOut) {
    return {
      category: "quality",
      outcome: "fail-timeout",
      retriable: true,
      message: "[callOp] agent timed out before completing its turn",
      reason: "wall-clock-timeout",
    };
  }

  if (turn.turnIncomplete) {
    return {
      category: "quality",
      outcome: "fail-quality",
      retriable: true,
      message: "[callOp] agent turn ended with tool calls outstanding",
      reason: "turn-incomplete",
    };
  }

  if (turn.output && turn.output.trim().length > 0) return null;

  return {
    category: "availability",
    outcome: "fail-stale",
    retriable: true,
    message: "[callOp] agent returned no output",
    reason: "empty-output",
  };
}
```

Update the file's header comment block to match: the old rules list says "When the trimmed output has length > 0, return null" and "When output is empty ... and timedOut is true", both of which are now wrong. Replace those two bullets with:

```
 *   - When the turn reports a transport fact (`timedOut`, then
 *     `turnIncomplete`), classify from that fact regardless of output. A
 *     truncated turn usually HAS prose, so checking output first hid it.
 *   - Otherwise, when the trimmed output has length > 0, return null.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/unit/operations/turn-failure-classification.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Verify the gate by reintroducing the bug**

Move `if (turn.output && turn.output.trim().length > 0) return null;` back above the `timedOut` check and re-run.
Expected: FAIL on both new tests. Restore the correct order.

- [ ] **Step 6: Run the full suite and triage acpx fallout**

Run: `bun run test`

This step is expected to surface failures elsewhere, and that is the point: turns that previously classified as silent successes now classify as failures. For each failure, decide deliberately and record the decision in the commit body:
- A test asserting a timed-out turn with partial output yields `null` is asserting the **old, wrong** behaviour. Update it to expect `fail-timeout`.
- A test that breaks because a fixture sets `timedOut: true` incidentally while meaning "finished" has a wrong fixture. Fix the fixture, not the classifier.
- Do **not** weaken the classifier to make a test pass.

- [ ] **Step 7: Format, lint, typecheck**

```bash
bun x biome check --write src/operations/turn-failure-classification.ts test/unit/operations/turn-failure-classification.test.ts
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 8: Commit**

```bash
git add src/operations/turn-failure-classification.ts test/unit/operations/turn-failure-classification.test.ts
git commit -m "fix(operations): classify a truncated turn from transport facts, not output emptiness (#1819)"
```

---

### Task 4: Native emits stream activity and registers a cancel handle

Implements spec story S4. Makes `agent.idleWatchdog` real on native, in both `observe` and `cancel` modes.

**Files:**
- Create: `src/agents/native/session/turn-events.ts`
- Create: `test/unit/agents/native/turn-events.test.ts`
- Modify: `src/agents/native/session/session.ts`
- Modify: `src/agents/native/adapter.ts`
- Modify: `src/agents/native/session/turn-loop.ts`
- Modify: `src/runtime/index.ts:307`
- **Do not modify `src/session/manager.ts`** — it is baselined at 744 against a 600 limit and cannot grow. The `runId` backfill in `runtime/index.ts` exists precisely so this task does not have to touch it.

**Interfaces:**
- Consumes: `TurnDeps` from Task 2.
- Produces:
  - `TurnDeps.onActivity?: (a: NativeTurnActivity) => void`
  - `type NativeTurnActivity = { kind: "message"; bytes: number } | { kind: "thinking"; bytes: number } | { kind: "usage"; inputTokens: number; outputTokens: number; costUsd: number } | { kind: "tool"; toolName: string }`
  - `buildNativeStreamEvent(base, activity, timestamp): AgentStreamEvent`
  - `nativeSessionStreamHooks: Map<string, { onStreamActivity?; onActiveCall? }>` exported from `session/session.ts`

- [ ] **Step 1: Write the failing test for event construction**

Create `test/unit/agents/native/turn-events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildNativeStreamEvent } from "@/agents/native/session/turn-events";

const base = { callId: "call-1", runId: "run-1", agentName: "native", sessionName: "sess-a" };

describe("native stream events", () => {
  test("maps a message activity to agent.message_update with its byte size", () => {
    const ev = buildNativeStreamEvent(base, { kind: "message", bytes: 42 }, 1000);
    expect(ev).toMatchObject({ kind: "agent.message_update", deltaBytes: 42, callId: "call-1", timestamp: 1000 });
  });

  test("maps a tool activity to agent.tool_call_update carrying the tool name", () => {
    const ev = buildNativeStreamEvent(base, { kind: "tool", toolName: "Write" }, 2000);
    expect(ev).toMatchObject({ kind: "agent.tool_call_update", toolName: "Write" });
  });

  test("maps a usage activity to agent.usage_update with tokens and cost", () => {
    const ev = buildNativeStreamEvent(
      base,
      { kind: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.5 },
      3000,
    );
    expect(ev).toMatchObject({ kind: "agent.usage_update", inputTokens: 10, outputTokens: 3, costUsd: 0.5 });
  });

  test("maps a thinking activity to agent.thinking_update", () => {
    const ev = buildNativeStreamEvent(base, { kind: "thinking", bytes: 7 }, 4000);
    expect(ev).toMatchObject({ kind: "agent.thinking_update", deltaBytes: 7 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/native/turn-events.test.ts --timeout=5000`
Expected: FAIL — cannot resolve `@/agents/native/session/turn-events`.

- [ ] **Step 3: Write the event builder**

Create `src/agents/native/session/turn-events.ts`:

```ts
/**
 * Native round-trip activity -> AgentStreamEvent.
 *
 * The idle watchdog subscribes to the runtime stream bus and tracks calls from
 * these events; nothing under src/agents/native/ emitted any, so
 * `agent.idleWatchdog` was inert on every native session in both modes.
 *
 * Native has no token streaming — one `complete()` is a single call — so these
 * are emitted at round-trip boundaries rather than continuously. That is
 * sufficient: a HUNG call is already bounded by the per-call abort, and the
 * watchdog's unique job is the productive-looking loop that keeps calling tools
 * forever, which emits `tool` on every iteration and trips
 * `toolCallOnlyIdleTimeout`.
 */

import type { AgentStreamEvent } from "@/runtime/agent-stream-events";

export type NativeTurnActivity =
  | { kind: "message"; bytes: number }
  | { kind: "thinking"; bytes: number }
  | { kind: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { kind: "tool"; toolName: string };

export interface NativeStreamEventBase {
  readonly callId: string;
  readonly runId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: import("@/config").PipelineStage;
}

export function buildNativeStreamEvent(
  base: NativeStreamEventBase,
  activity: NativeTurnActivity,
  timestamp: number,
): AgentStreamEvent {
  const common = { ...base, timestamp };
  switch (activity.kind) {
    case "message":
      return { ...common, kind: "agent.message_update", deltaBytes: activity.bytes };
    case "thinking":
      return { ...common, kind: "agent.thinking_update", deltaBytes: activity.bytes };
    case "usage":
      return {
        ...common,
        kind: "agent.usage_update",
        inputTokens: activity.inputTokens,
        outputTokens: activity.outputTokens,
        costUsd: activity.costUsd,
      };
    case "tool":
      return { ...common, kind: "agent.tool_call_update", toolName: activity.toolName };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/unit/agents/native/turn-events.test.ts --timeout=5000`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for loop emission**

Append to `test/unit/agents/native/turn-loop.test.ts`:

```ts
  test("reports usage, message and tool activity for every round trip", async () => {
    const seen: string[] = [];
    let round = 0;
    await runNativeTurn(handle, "hi", opts(), {
      onActivity: (a) => seen.push(a.kind),
      complete: async () => {
        round += 1;
        return round === 1
          ? reply({ text: "calling", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] })
          : reply({ text: "done" });
      },
    });
    // Round 1: usage + message + one tool. Round 2: usage + message.
    expect(seen.filter((k) => k === "usage")).toHaveLength(2);
    expect(seen.filter((k) => k === "tool")).toHaveLength(1);
    expect(seen).toContain("message");
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: FAIL — `onActivity` is not a known property of `TurnDeps`; `seen` stays empty.

- [ ] **Step 7: Emit activity from the loop**

In `src/agents/native/session/turn-loop.ts`, add to the imports:

```ts
import type { NativeTurnActivity } from "./turn-events";
```

Extend `TurnDeps` with:

```ts
  /**
   * Per-round-trip observability hook. Absent in unit tests; the adapter
   * supplies one that forwards onto the runtime stream bus so the idle
   * watchdog can see native sessions.
   */
  onActivity?: (activity: NativeTurnActivity) => void;
```

Inside the `while` loop, immediately after `output = res.text;`, add:

```ts
    deps.onActivity?.({
      kind: "usage",
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: res.costUsd,
    });
    if (res.text.length > 0) deps.onActivity?.({ kind: "message", bytes: res.text.length });
    if (res.thinking !== undefined && res.thinking.length > 0) {
      deps.onActivity?.({
        kind: "thinking",
        bytes: res.thinking.reduce((n, t) => n + t.text.length, 0),
      });
    }
```

Inside the `for (const call of res.toolCalls)` loop, as its first statement (before the `try`), add:

```ts
      deps.onActivity?.({ kind: "tool", toolName: call.name });
```

- [ ] **Step 8: Run it to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 9: Store the per-session hooks**

In `src/agents/native/session/session.ts`, add after the `nativeSessionTimeouts` declaration:

```ts
/**
 * Session name -> the runtime hooks handed to openSession. SessionManager
 * passes both (manager.ts, openSession) and the native adapter previously
 * ignored them, which is why the idle watchdog never covered native. Same
 * lifecycle as `nativeTranscriptDirs`: set on open, cleared on close only.
 */
export const nativeSessionStreamHooks = new Map<
  string,
  {
    onStreamActivity?: (event: import("@/runtime/agent-stream-events").AgentStreamEvent) => void;
    onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  }
>();
```

In `openNativeSession`, after `nativeSessionTimeouts.set(name, opts.timeoutSeconds);`:

```ts
  nativeSessionStreamHooks.set(name, {
    ...(opts.onStreamActivity !== undefined ? { onStreamActivity: opts.onStreamActivity } : {}),
    ...(opts.onActiveCall !== undefined ? { onActiveCall: opts.onActiveCall } : {}),
  });
```

In `closeNativeSession`, next to `nativeSessionTimeouts.delete(handle.id);`:

```ts
  nativeSessionStreamHooks.delete(handle.id);
```

- [ ] **Step 10: Wire the adapter**

In `src/agents/native/adapter.ts`, extend the session-store import:

```ts
import { closeNativeSession, nativeSessionStreamHooks, nativeSessionTimeouts, openNativeSession } from "./session/session";
```

and add:

```ts
import { randomUUID } from "node:crypto";
import { buildNativeStreamEvent } from "./session/turn-events";
```

In `sendTurn`, immediately after `const deadline = createTurnDeadline(timeoutSeconds);` from Task 2, add:

```ts
    const hooks = nativeSessionStreamHooks.get(handle.id);
    // One callId per turn, mirroring SpawnAcpSession.prompt(). `runId` is
    // backfilled by the runtime's forwarding closure, which is the only place
    // that knows it — see runtime/index.ts.
    const callId = randomUUID();
    const eventBase = { callId, runId: "", agentName: handle.agentName, sessionName: handle.id };
    const turnController = new AbortController();
    // The watchdog's cancel handle IS the turn controller, so an idle cancel
    // and the whole-turn deadline end the same in-flight call. Registering
    // through the hook (rather than a private registry) is what lets
    // sendPrompt tell a watchdog cancel from an unrelated process kill.
    hooks?.onActiveCall?.(callId, async () => turnController.abort());
    hooks?.onStreamActivity?.({
      ...eventBase,
      kind: "agent.call_started",
      model: handle.modelDef?.model ?? "",
      timeoutSeconds: timeoutSeconds ?? 0,
      timestamp: Date.now(),
    });
```

Add `onActivity` to the `runNativeTurn` deps object, next to `deadline`:

```ts
      onActivity: (activity) => {
        hooks?.onStreamActivity?.(buildNativeStreamEvent(eventBase, activity, Date.now()));
      },
```

Include the turn controller in the per-call signal. Replace the `const signal = ...` line inside `complete` with:

```ts
        const signal = AbortSignal.any(
          opts.signal !== undefined
            ? [opts.signal, controller.signal, turnController.signal]
            : [controller.signal, turnController.signal],
        );
```

Finally, make `agent.call_ended` fire on **every** exit path — it is what depopulates the
watchdog registry (`manager.ts` subscribes to `agent.call_ended` for exactly this, and the
ACP client emits it synchronously even when the prompt throws). A turn that throws must not
leave a registry entry behind forever, so this needs `try`/`catch`, not a plain trailing call:

```ts
    let result: TurnResult;
    try {
      result = await runNativeTurn(handle, prompt, opts, {
        deadline,
        onActivity: (activity) => {
          hooks?.onStreamActivity?.(buildNativeStreamEvent(eventBase, activity, Date.now()));
        },
        complete: async (messages, tools) => {
          /* body from Task 2 Step 9, with the turnController added to the signal */
        },
      });
    } catch (err) {
      hooks?.onStreamActivity?.({
        ...eventBase,
        kind: "agent.call_ended",
        status: turnController.signal.aborted ? "cancelled" : "error",
        timestamp: Date.now(),
      });
      throw err;
    }

    hooks?.onStreamActivity?.({
      ...eventBase,
      kind: "agent.call_ended",
      status: result.timedOut === true ? "timeout" : turnController.signal.aborted ? "cancelled" : "success",
      timestamp: Date.now(),
    });
    return result;
```

A `finally` would be shorter but cannot distinguish the four statuses, and the status is the
part the watchdog and the prompt audit actually read. `sendTurn` is already `async`. Keep the
`complete` body exactly as Task 2 Step 9 left it, with the `turnController` added to its
signal as described above — it is elided here only to keep this step readable.

- [ ] **Step 11: Backfill `runId` in the runtime**

In `src/runtime/index.ts`, replace line 307:

```ts
      onStreamActivity: (event) => agentStreamEvents.emitAgentStream(event),
```

with:

```ts
      onStreamActivity: (event) => agentStreamEvents.emitAgentStream(event.runId ? event : { ...event, runId }),
```

`runId` is already in scope from line 248. This is a one-line change in a non-baselined file, and it is why `src/session/manager.ts` (frozen at 744) needs no edit at all.

- [ ] **Step 12: Verify the gate by reintroducing the bug**

Temporarily delete the `deps.onActivity?.({ kind: "tool", ... })` line and re-run:

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: FAIL on `reports usage, message and tool activity...` with the tool count at 0. Restore it.

- [ ] **Step 13: Format, size-check, lint, typecheck, full suite**

```bash
bun x biome check --write src/agents/native/session/turn-events.ts src/agents/native/session/session.ts src/agents/native/adapter.ts src/agents/native/session/turn-loop.ts src/runtime/index.ts test/unit/agents/native/turn-events.test.ts test/unit/agents/native/turn-loop.test.ts
grep -c '' src/agents/native/adapter.ts src/agents/native/session/turn-loop.ts src/runtime/index.ts
git diff --stat src/session/manager.ts   # must be empty
bun run typecheck && bun run lint && bun run test
```

Expected: `manager.ts` untouched, all touched files under their limits, suite PASS.

- [ ] **Step 14: Commit**

```bash
git add src/agents/native/session/turn-events.ts test/unit/agents/native/turn-events.test.ts src/agents/native/session/session.ts src/agents/native/adapter.ts src/agents/native/session/turn-loop.ts src/runtime/index.ts test/unit/agents/native/turn-loop.test.ts
git commit -m "feat(native): emit stream activity and register a cancel handle so the idle watchdog covers native (#1821)"
```

---

### Task 5: Remove the round-trip cap and split the counter

Implements spec story S5. Lands only after both replacement guards exist.

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts`
- Modify: `src/runtime/session-run-hop.ts:62-65`
- Modify: `src/operations/build-hop-callback.ts:425-430`
- Test: `test/unit/agents/native/turn-loop.test.ts`

**Interfaces:**
- Consumes: `TurnDeps.deadline` (Task 2), `TurnDeps.onActivity` (Task 4).
- Produces: `runNativeTurn` no longer reads `opts.maxTurns` for round-trips. `opts.maxTurns` continues to bound human Q&A exchanges only (wired in Task 6). `DEFAULT_MAX_TURNS` is deleted.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/turn-loop.test.ts`:

```ts
  test("runs past ten round trips when the model keeps working", async () => {
    let round = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      complete: async () => {
        round += 1;
        return round < 25
          ? reply({ text: "working", toolCalls: [{ id: `c${round}`, name: "query_neighbor", input: {} }] })
          : reply({ text: "finished after 25" });
      },
    });
    expect(result.internalRoundTrips).toBe(25);
    expect(result.output).toBe("finished after 25");
    expect(result.turnIncomplete).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: FAIL — `internalRoundTrips` is 10 (the `DEFAULT_MAX_TURNS` fallback) and `turnIncomplete` is `true`.

- [ ] **Step 3: Delete the cap**

In `src/agents/native/session/turn-loop.ts`:

Delete the constant and its comment:

```ts
/** Matches SendTurnOpts.maxTurns' documented default. */
const DEFAULT_MAX_TURNS = 10;
```

Delete the resolution line `const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;`.

Replace the loop header:

```ts
  while (roundTrips < maxTurns) {
```

with:

```ts
  // Deliberately unbounded by count. A coding agent working a story is bounded
  // by wall clock (deps.deadline) and by the idle watchdog, never by how many
  // times it needed to call a tool. `agent.maxInteractionTurns` is NOT this
  // budget — it bounds human Q&A exchanges, which are counted separately.
  while (true) {
```

Remove `maxTurns` from the warn context object added in Task 1, leaving:

```ts
    getSafeLogger()?.warn("native-adapter", "turn ended with tool calls outstanding", {
      sessionName: handle.id,
      roundTrips,
      timedOut,
    });
```

- [ ] **Step 4: Stop feeding the Q&A budget to the round-trip cap**

In `src/runtime/session-run-hop.ts`, **change the comment only — do NOT change the value.**
Leave lines 62-65 computing exactly what they compute today and add above them:

```ts
      // `maxInteractionTurns` is the human Q&A budget (config-descriptions.ts),
      // not an agent round-trip cap. Forwarded unchanged: acpx's iterations ARE
      // interaction turns and it still consumes this as its loop bound, while
      // the native loop no longer reads it for round-trips at all (it is bounded
      // by time) and spends it only on ask_human exchanges.
```

**Do not drop the `?? 1` fallback.** It is what keeps a bridge-less, context-tool-less acpx
call single-turn. Removing it lets `maxTurns` reach the adapter as `undefined`, where
`acp/adapter.ts`'s `opts.maxTurns ?? 10` turns a deliberate 1-turn call into a 10-turn one —
a live behaviour change on the busiest transport, entirely unrelated to this arc.

In `src/operations/build-hop-callback.ts`, replace lines 425-430's conditional spread:

```ts
          ...(hasContextTools
            ? { maxTurns: maxInteractionTurns ?? 10 }
            : maxInteractionTurns !== undefined
              ? { maxTurns: maxInteractionTurns }
              : {}),
```

with:

```ts
          // Mirrors session-run-hop.ts — the two must not drift. Forwarded as
          // the Q&A budget it is documented to be; the native loop no longer
          // spends it on round-trips.
          ...(hasContextTools
            ? { maxTurns: maxInteractionTurns ?? 10 }
            : maxInteractionTurns !== undefined
              ? { maxTurns: maxInteractionTurns }
              : {}),
```

(The value is unchanged here on purpose — acpx still consumes it correctly. Only the comment changes, so the reader is not misled into thinking it is a round-trip cap.)

- [ ] **Step 5: Retire the now-unbounded Task 1 fixture FIRST**

Do this before running anything. The Task 1 test `flags an incomplete turn when the cap
cuts the loop off mid-work` feeds a completion that always returns tool calls and relied
on the cap to stop it. With the cap gone that fixture loops forever, so the run will hang
rather than fail. Replace that whole test with one driving the same condition through the
deadline:

```ts
  test("flags an incomplete turn when the budget cuts the loop off mid-work", async () => {
    let now = 0;
    const result = await runNativeTurn(handle, "hi", opts(), {
      deadline: createTurnDeadline(10, () => now),
      complete: async () => {
        now += 6_000;
        return reply({ text: "still working on it", toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }] });
      },
    });
    expect(result.output).toBe("still working on it");
    expect(result.turnIncomplete).toBe(true);
  });
```

Then scan the rest of the file for any other fixture that returns tool calls
unconditionally and relied on `maxTurns` to terminate. Each must gain either a deadline or
a completion that eventually returns no tool calls.

- [ ] **Step 5b: Run it to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: PASS. If the run hangs instead of failing, an unbounded fixture was missed — find it before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/agents/native/session/turn-loop.ts src/runtime/session-run-hop.ts src/operations/build-hop-callback.ts test/unit/agents/native/turn-loop.test.ts
git commit -m "feat(native): remove the round-trip cap, leaving time-based guards (#1819 #1820)"
```

---

### Task 6: Ask-human tool bounded by maxInteractionTurns

Implements spec story S6. Gives native the human Q&A path its budget has always named, and makes `maxInteractionTurns` honest there.

**Files:**
- Create: `src/agents/native/session/ask-human.ts`
- Modify: `src/agents/native/session/turn-loop.ts`
- Test: `test/unit/agents/native/turn-loop.test.ts`

**Interfaces:**
- Consumes: `opts.maxTurns` (now unused for round-trips after Task 5), `opts.interactionHandler`, `TurnResult.interactions`.
- Produces: `ASK_HUMAN_TOOL_NAME = "ask_human"` and `askHumanToolDefinition` from `session/ask-human.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/turn-loop.test.ts`:

```ts
  test("routes an ask_human call to the interaction handler and records the exchange", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        interactionHandler: {
          onInteraction: async (r) => (r.kind === "question" ? { answer: "use postgres" } : { answer: "" }),
        },
      }),
      {
        complete: async () => {
          round += 1;
          return round === 1
            ? reply({ text: "", toolCalls: [{ id: "q1", name: "ask_human", input: { text: "which database?" } }] })
            : reply({ text: "using postgres" });
        },
      },
    );
    expect(result.output).toBe("using postgres");
    expect(result.interactions).toEqual([{ turnIndex: 1, question: "which database?", reply: "use postgres" }]);
  });

  test("stops asking once maxInteractionTurns is spent, and says so", async () => {
    let asked = 0;
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        maxTurns: 2,
        interactionHandler: {
          onInteraction: async (r) => {
            if (r.kind === "question") asked += 1;
            return { answer: "yes" };
          },
        },
      }),
      {
        complete: async () => {
          round += 1;
          // Asks five times, so only the budget — not the fixture — can stop it
          // at two. Terminates on its own so the test can never hang.
          return round <= 5
            ? reply({ text: "asking", toolCalls: [{ id: `q${round}`, name: "ask_human", input: { text: "again?" } }] })
            : reply({ text: "done asking" });
        },
      },
    );
    // Exactly two, not "at most two": an off-by-one or a missing check must fail.
    expect(asked).toBe(2);
    expect(result.interactions).toHaveLength(2);
    // Calls past the budget are refused as data the model can act on, not dropped.
    expect(result.output).toBe("done asking");
  });

  test("an unanswerable question consumes no budget and records no exchange", async () => {
    let round = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      opts({
        maxTurns: 2,
        // Mirrors run-interaction-handler.ts: kind "question" returns null when
        // no interactionBridge is configured for the run.
        interactionHandler: { onInteraction: async () => null },
      }),
      {
        complete: async () => {
          round += 1;
          return round <= 3
            ? reply({ text: "asking", toolCalls: [{ id: `q${round}`, name: "ask_human", input: { text: "hello?" } }] })
            : reply({ text: "gave up asking" });
        },
      },
    );
    // Three asks against a budget of two: if a null answer consumed budget, the
    // third would have been refused for the wrong reason and this would be 2.
    expect(result.interactions).toBeUndefined();
    expect(result.output).toBe("gave up asking");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: FAIL — `ask_human` is routed as a context-tool, `r.kind` is never `"question"`, and `result.interactions` is `undefined`.

- [ ] **Step 3: Write the tool definition**

Create `src/agents/native/session/ask-human.ts`:

```ts
/**
 * The native human-Q&A channel.
 *
 * `AdapterInteraction` has always declared `{ kind: "question" }`, but the
 * native loop routed only context-tools and coding-tools, so on native the
 * operator could never be asked anything — while `agent.maxInteractionTurns`,
 * the budget that names exactly this, was being spent as a round-trip cap.
 *
 * A declared tool rather than acpx's output parsing (acp/adapter.ts): the
 * native protocol has a structured tool channel, and parsing prose for a
 * question when a structured call is available is the weaker mechanism.
 */

import type { ToolDefinition } from "@nathapp/nax-ai";

export const ASK_HUMAN_TOOL_NAME = "ask_human";

export const askHumanToolDefinition: ToolDefinition = {
  name: ASK_HUMAN_TOOL_NAME,
  description:
    "Ask the human operator a question and wait for their reply. Use only when genuinely blocked: the budget is small and each call costs a round trip.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The question to put to the operator." } },
    required: ["text"],
  },
};
```

- [ ] **Step 4: Route it in the loop**

In `src/agents/native/session/turn-loop.ts`, add to the imports:

```ts
import type { InteractionExchange } from "@/agents/session-types";
import { ASK_HUMAN_TOOL_NAME, askHumanToolDefinition } from "./ask-human";
```

Advertise the tool. Replace the `tools` construction:

```ts
  const tools = [...toToolDefinitions(opts.contextPullTools ?? []), ...codingToolsToDefinitions(codingTools)];
```

with:

```ts
  // Advertised only while the Q&A budget can still be spent; a tool the model
  // cannot successfully call is worse than no tool.
  const maxInteractions = opts.maxTurns ?? 0;
  const tools = [
    ...toToolDefinitions(opts.contextPullTools ?? []),
    ...codingToolsToDefinitions(codingTools),
    ...(maxInteractions > 0 ? [askHumanToolDefinition] : []),
  ];
```

Declare the counter alongside the other accumulators:

```ts
  const interactions: InteractionExchange[] = [];
```

Inside the `for (const call of res.toolCalls)` loop, as the first statement inside the
`try` block. Task 4 put `deps.onActivity?.({ kind: "tool", ... })` immediately BEFORE the
`try`, so this branch goes directly after the `try {` that follows it — an ask_human call
is still real tool activity and must keep emitting its watchdog event. Add:

```ts
        if (call.name === ASK_HUMAN_TOOL_NAME) {
          const question = String((call.input as { text?: unknown } | undefined)?.text ?? "");
          if (interactions.length >= maxInteractions) {
            messages.push({
              role: "tool-result",
              toolCallId: call.id,
              content: "The human Q&A budget for this turn is spent. Proceed on your best judgement.",
              isError: true,
            });
            continue;
          }
          const answer = await opts.interactionHandler.onInteraction({ kind: "question", text: question });
          // A null answer means no operator is reachable — run-interaction-handler
          // returns null for kind:"question" when no interactionBridge is
          // configured. That is not an exchange: it must not consume budget and
          // must not be recorded as a question the operator answered with "".
          if (answer === null) {
            messages.push({
              role: "tool-result",
              toolCallId: call.id,
              content: "No human operator is available for this run. Proceed on your best judgement.",
              isError: true,
            });
            continue;
          }
          interactions.push({ turnIndex: roundTrips, question, reply: answer.answer });
          messages.push({ role: "tool-result", toolCallId: call.id, content: answer.answer });
          continue;
        }
```

Add to the returned object:

```ts
    ...(interactions.length > 0 ? { interactions } : {}),
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 6: Verify the gate by reintroducing the bug**

Temporarily delete the `if (call.name === ASK_HUMAN_TOOL_NAME) { ... }` block and re-run.
Expected: FAIL on `routes an ask_human call...` — `interactions` is `undefined` and the handler saw `kind: "context-tool"`. Restore the block.

- [ ] **Step 7: Format, size-check, lint, typecheck, full suite**

```bash
bun x biome check --write src/agents/native/session/ask-human.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop.test.ts
grep -c '' src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop.test.ts
bun run typecheck && bun run lint && bun run test
```

Expected: `turn-loop.ts` under 600, the test file under 800. If the test file is close to 800, split the ask-human tests into `test/unit/agents/native/turn-loop-ask-human.test.ts` rather than trimming assertions.

- [ ] **Step 8: Commit**

```bash
git add src/agents/native/session/ask-human.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop.test.ts
git commit -m "feat(native): add the ask_human tool bounded by maxInteractionTurns (#1820)"
```

---

## Live Verification

Run after all six tasks are green. This is the measurement the arc is judged on; the unit gates prove mechanism, this proves the 44% is gone.

- [ ] **Step 1: Copy the fixture repo**

A nax run auto-commits onto the current branch, so never run this against a working clone.

```bash
git clone https://github.com/nathapp-io/nax-context-dogfood /tmp/nax-turn-cap-verify
cd /tmp/nax-turn-cap-verify
```

- [ ] **Step 2: Run the `native-full-run` fixture**

Use the same configuration as the 2026-09-03 baseline: model `openrouter/deepseek/deepseek-v4-flash` on all three native tiers, full run `plan`(refine) → `acceptance-generate` → three-session TDD → single-session implementer → semantic+adversarial → non-blocking fix.

- [ ] **Step 3: Measure the turn distribution**

```bash
jq -r '.turn' ~/.nax/*/prompt-audit/*/*.jsonl | sort -n | uniq -c
```

Baseline to beat: **24 of 55 calls (44%) at exactly turn 10**, and all nine near-empty responses at turn 10 with zero at any other turn.

Success criteria:
- No cluster at turn 10. Counts spread past 10 wherever the work needed it.
- No near-empty responses correlated with any single turn number.
- No `fail-stale` with `{"reason":"empty-output","agent":"native"}` caused by budget exhaustion. A genuine `fail-timeout` / `wall-clock-timeout` is the correct new outcome and is not a regression.
- Cost anchor for comparison: the baseline was 2/2 passing in 24m49s at $0.0921. A large cost increase is expected and acceptable (the cap was suppressing work), but a runaway indicates the deadline is not binding.

- [ ] **Step 4: Confirm the watchdog now sees native**

```bash
grep -c "Watchdog tracking call" ~/.nax/*/logs/*.log
```

Expected: greater than zero for a native run. This line appears for acpx and never for native before Task 4, making it a clean before/after discriminator.

---

## Risks Carried From the Spec

1. **The native deadline path has never fired in any run log.** `adapter.ts`'s abort is untested in practice, and it is unverified whether that throw is misclassified as `availability` by `build-hop-callback`'s catch. Task 2 covers it at unit level; a dedicated end-to-end forced-timeout story was considered and deliberately not scoped. If the live run in Step 3 shows `availability` failures where `fail-timeout` was expected, that is this risk landing — file it rather than patching the classifier under time pressure.
2. **Removing the cap removes an incidental cost bound.** A pathological turn can now spend up to a full hour of model calls where it previously stopped at ten. Wall-clock is bounded; spend within it is not.
3. **Task 3 reclassifies acpx turns that currently pass silently.** Intended, but it lands as a live behaviour change on the transport carrying most traffic. Step 6 of Task 3 is where that surfaces; triage it deliberately rather than by making tests green.
