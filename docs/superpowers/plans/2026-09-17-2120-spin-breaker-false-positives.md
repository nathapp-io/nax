# Spin-Breaker False-Positive Fixes (nax#2120) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the spin breaker killing healthy edit-test loops, while keeping the nax#2013 (622-call wedged verifier) and nax#2047 (laundered repeat loop) catches intact.

**Architecture:** Three independent defects in `src/runtime/spin-breaker/index.ts`, fixed in severity order, plus one change to the turn loop's stop path. (1) The cumulative per-key counter never decays after firing, so it latches and re-kills every subsequent turn in the session — fixed by making a stop consume the evidence it fired on. (2) The cumulative stop returns before `repeatsSinceProgress` is incremented, so for loops of fewer than three distinct keys the nudge ladder is unreachable by arithmetic — fixed by an invariant in the mechanism (any stop downgrades to a nudge while nudges remain), not by a config refinement. (3) The cumulative counter has no progress axis, so twelve legitimate edit-test iterations read identically to twelve idle re-runs — fixed by counting only repeats whose *result* was unchanged, which is what the nudge copy already claims to measure. Finally, the stop path leaves the triggering call unexecuted and unanswered and tears the turn down; it gets one terminal warning round trip so the turn ends with an answer.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies. No new config knobs.

**Spec:** No separate spec document. The argument for these changes is https://github.com/nathapp-io/nax/issues/2120 plus its correction comment https://github.com/nathapp-io/nax/issues/2120#issuecomment-5717125446 — read both before starting. Field evidence: run `run-2026-09-17T11-43-47-190Z`, feature `glob-directory-grouped-output`, story US-001.

## Global Constraints

- **Do NOT reset the breaker per turn.** One `SpinBreaker` instance per session, spanning every turn, is deliberate nax#2047 behaviour created by moving construction out of `runNativeTurn`. It is pinned by `test/unit/agents/native/session/session-lifetime-spin.test.ts`. Reverting it re-opens #2047. Every fix here must preserve cross-turn lifetime.
- **Do NOT exempt a repeat because a mutating tool ran.** The original issue suggested it; the correction comment withdraws it. Editing an unrelated file, or editing and reverting, between identical calls would launder past the check — a cheaper escape than the interleaving #2047 was hardened against.
- **No new config fields.** `agent.spinBreaker` already has six knobs declared in two places (`src/config/schemas-infra.ts` `AgentSpinBreakerConfigSchema` plus `DEFAULT_AGENT_SPIN_BREAKER_CONFIG`, and `src/cli/config-descriptions.ts`). Every threshold added here is derived from existing knobs.
- **`src/runtime/spin-breaker/index.ts` must stay transport-neutral and config-free.** It takes resolved settings so `src/agents/native/` can consult it without importing `NaxConfig` — enforced by `check:adapter-no-config-import`. Never import from `src/config/` here.
- **File-size gate:** `SRC_LIMIT = 600` lines, `TEST_LIMIT = 800` (`scripts/check-file-sizes.ts`). Current: `src/runtime/spin-breaker/index.ts` 233, `src/agents/native/session/turn-loop.ts` 506, `test/unit/runtime/spin-breaker.test.ts` 330. Task 4 adds roughly 30 lines to turn-loop.ts — still under. Do not let any file cross its limit.
- **Test command is `bun run test`, never bare `bun test`.** Bare `bun test` gives a confident false signal in this repo. Single files: `bun test <path> --timeout=5000` is acceptable for the inner TDD loop, but every task's final gate is `bun run test`.
- **`typecheck` is NOT in `check:all`.** Run `bun run typecheck` explicitly before every commit.
- **No literal control bytes in any file.** `check:no-control-bytes` is part of `lint:checks`. Where a test needs an ANSI escape, write it as the two-character TypeScript escape `\x1b`, never as a raw byte.
- **Never put `\x1b` inside a regex literal.** Biome's `lint/suspicious/noControlCharactersInRegex` rejects it — verified by running `bun x biome check` on a probe file containing exactly the regex this plan originally proposed. Strip ANSI with the existing `stripControlChars` from `src/utils/strip-control-chars.ts` instead; it already carries the three `biome-ignore` lines needed to be the one place this rule is waived.
- **Every number in this plan's assertions was verified by simulating the proposed algorithm**, not derived by hand. If you change the algorithm, re-derive the indices — several of them moved during review (the post-Task-3 stop index is 16, not the 15 that the same test expects after Task 2, because of `noteResult`'s one-call lag).

---

### Task 1: A stop consumes the evidence it fired on (the ratchet)

The cumulative count for a key is only ever incremented or evicted from the window. Once `cumulativeCount >= stopAfterSameKeyRepeats` is true it stays true, so after the first kill *every following turn in that session dies on the first re-occurrence of that key* — at 13, 14, 15, with `nudges: 0` each time, until `closeNativeSession` evicts the breaker. That is the observed pair of kills six seconds apart (`totalCalls` 96 to 100, `repeats` 12 to 13: continuous counters across two different turns).

Fix: when the cumulative check actually returns `stop`, zero that key's count. The stop ended a turn and the retry lane dropped the transcript; the evidence has been spent. The key stays in `recent` (so its next occurrence is still a repeat, not a new-key event) and must re-accumulate the full threshold to fire again.

**Files:**
- Modify: `src/runtime/spin-breaker/index.ts:196-206`
- Test: `test/unit/runtime/spin-breaker.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no API change. `observe(toolName: string, input: unknown): SpinVerdict` keeps its signature. Behaviour change only.

- [ ] **Step 1: Write the failing test**

> **These two tests get updated by later tasks in this same plan.** `firstStopAt` becomes 15 once Task 2 spends the ladder, and the whole test moves onto `noteResult` in Task 3. Each task says so at the point it changes them. Do not treat those later edits as churn — the behaviour under test genuinely moves.

Append inside the existing `describe("createSpinBreaker", ...)` block in `test/unit/runtime/spin-breaker.test.ts`:

```typescript
  // nax#2120 defect 3 (the ratchet): the cumulative count latched at the
  // threshold, so every later occurrence of that key re-killed instantly.
  // The breaker is session-scoped by design (nax#2047), so "latched" meant
  // every subsequent TURN died on its first re-occurrence of the key.
  test("a cumulative stop resets that key's count, so the next occurrence does not re-kill", () => {
    const breaker = createSpinBreaker(settings());

    let firstStopAt: number | undefined;
    for (let i = 0; i < 12 && firstStopAt === undefined; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") firstStopAt = i + 1;
    }
    expect(firstStopAt).toBe(12);

    // The 11 occurrences after the stop must all be allowed: the count
    // restarts from zero and has to climb the full threshold again.
    for (let i = 0; i < 11; i += 1) {
      expect(breaker.observe("RunCommand", TEST_CMD).action).not.toBe("stop");
    }
    // The 12th does fire again — a genuinely wedged session still dies.
    expect(breaker.observe("RunCommand", TEST_CMD).action).toBe("stop");
  });

  test("a stop does not turn the key into a new-key event", () => {
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 12; i += 1) breaker.observe("RunCommand", TEST_CMD);
    const newKeysAfterStop = breaker.summary().newKeyEvents;
    breaker.observe("RunCommand", TEST_CMD);

    // Resetting the count must not look like progress: newKeyEvents is the
    // "did something new happen" instrument and a re-issued key is not new.
    expect(breaker.summary().newKeyEvents).toBe(newKeysAfterStop);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=5000 -t "resets that key"`

Expected: FAIL. The first `expect(...).not.toBe("stop")` fails on the very first post-stop call, because `cumulativeCount` is 13 and still `>= 12`.

- [ ] **Step 3: Write the minimal implementation**

In `src/runtime/spin-breaker/index.ts`, replace the cumulative stop block (currently lines 193-206) with:

```typescript
      // Cumulative per-key stop. A freshly-laundered loop is the shape we
      // want to catch (nax#2047). Only check when the knob is non-zero —
      // 0 disables.
      if (settings.stopAfterSameKeyRepeats > 0 && cumulativeCount >= settings.stopAfterSameKeyRepeats) {
        // nax#2120: the stop CONSUMES the evidence it fired on. Without this
        // the count stays above the threshold forever, and because the
        // breaker is session-scoped (nax#2047) every later turn died on its
        // first re-occurrence of this key — a ratchet, not a spin. Set to 0
        // rather than deleting the entry: the key must stay in `recent` so
        // its next occurrence still reads as a repeat, not as progress.
        recent.set(key, 0);
        getSafeLogger()?.error("spin-breaker", "Ending the turn — same call repeated with no progress", {
          tool: toolName,
          repeats: cumulativeCount,
          reason: "same-key-cumulative",
          newKeyEvents,
          totalCalls,
          nudges,
        });
        return { action: "stop", repeats: cumulativeCount, reason: "same-key-cumulative" };
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=5000`

Expected: PASS, all tests in the file. Note `maxSameKeyRepeats` is recorded before the reset (line 191), so the existing `summary reports what a later decision needs` test is unaffected.

- [ ] **Step 5: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/spin-breaker/index.ts test/unit/runtime/spin-breaker.test.ts
git commit -m "fix(spin-breaker): a cumulative stop consumes the evidence it fired on

The per-key cumulative count was only incremented or evicted, so once it
crossed stopAfterSameKeyRepeats it stayed above the threshold for the life
of the session. Because the breaker is session-scoped by design (nax#2047),
every subsequent turn then died on its FIRST re-occurrence of that key,
with nudges: 0 — a ratchet, not a spin. Observed as two kills six seconds
apart with continuous counters (totalCalls 96 to 100, repeats 12 to 13).

Refs nax#2120"
```

---

### Task 2: No stop without the nudge ladder spent

`nudgePoints()` puts the nudges at 25 / 33 / 42, but the cumulative check returns `stop` *before* `repeatsSinceProgress` is incremented. So for a loop over one or two already-seen keys the first nudge point is unreachable by arithmetic: a 1-key loop hits cumulative 12 at `repeatsSinceProgress` 11, and a 2-key alternation hits it at about 23 — both under 25. The escalation ladder is dead exactly where it is most needed, and `NUDGE_ESCALATION` never renders for the common case.

Fix this in the mechanism, not the config. A cross-field refinement (`stopAfterSameKeyRepeats > nudgeAfterRepeats`) cannot work: reachability depends on the loop's cycle length, not on the knobs. Instead, any stop verdict downgrades to a nudge while nudges remain, and the condition must re-trip to actually stop.

**Files:**
- Modify: `src/runtime/spin-breaker/index.ts` — `buildNudge` (161-175), both stop sites (196-206 as amended by Task 1, and 211-221)
- Test: `test/unit/runtime/spin-breaker.test.ts` — three EXISTING tests assert the defective behaviour and must be updated

**Interfaces:**
- Consumes: Task 1's `recent.set(key, 0)` reset, which must now happen only on a real stop, not on a downgraded nudge.
- Produces: new private helper `stopOrNudge(toolName: string, repeats: number, reason: "repeat-run" | "same-key-cumulative", onStop?: () => void): SpinVerdict`. `buildNudge` gains an explicit `repeats` parameter: `buildNudge(toolName: string, repeats: number): SpinVerdict`. No exported API change.

- [ ] **Step 1: Update the three existing tests that pin the defect**

These three currently encode the bug. Each needs its expectation moved by `maxNudges` (3) occurrences, because the threshold crossing now spends the ladder first.

In `test/unit/runtime/spin-breaker.test.ts`:

(a) `"stops at the 12th occurrence of one key regardless of what came between (cumulative counter)"` — change the final assertion and raise the loop bound:

```typescript
    for (let cycle = 0; cycle < 8; cycle += 1) {
```
```typescript
    // nax#2120: occurrences 12, 13 and 14 spend the three nudges; the stop
    // lands on 15. The ladder must always render before a kill.
    expect(stoppedAtA).toBe(15);
```

(b) `"interleaving does not reset the cumulative counter (the laundering hole)"` — this one cannot just be renumbered. Under strict `[A, B, A, B, ...]` alternation *both* keys accumulate, so A nudges at 12, B nudges at 12, A nudges at 13, and the ladder is spent by the time B reaches 13 — **the stop lands on B, at A-count 13**, not on A at 15. Recording the stop against `aCount` was only meaningful while the first stop was guaranteed to be A's. Rewrite it to assert the property it is actually for — interleaving does not buy immortality — rather than an index that now depends on which of two symmetric keys crosses first:

```typescript
  test("interleaving does not reset the cumulative counter (the laundering hole)", () => {
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };

    // [A, B, A, B, ...] — repeatsSinceProgress never exceeds 1, so the
    // nudgeAfterRepeats=25 path can never trip. Only the cumulative check
    // can end this, and it must, after spending the full ladder. Both keys
    // climb together, so which one finally crosses is symmetric and not
    // worth asserting; that the loop is bounded at all is the point.
    let stoppedAt: number | undefined;
    for (let i = 0; i < 40 && stoppedAt === undefined; i += 1) {
      if (breaker.observe("RunCommand", i % 2 === 0 ? KEY_A : KEY_B).action === "stop") stoppedAt = i + 1;
    }

    expect(stoppedAt).toBe(26);
    expect(breaker.summary().nudges).toBe(3);
  });
```

(c) `"stopAfterSameKeyRepeats defaults to 12 (sanity check that default trips at 12)"` — rename it and invert the `nudges` assertion, which is the exact line that pinned the defect:

```typescript
  test("the cumulative path spends the nudge ladder before it stops (nax#2120)", () => {
    // With the default settings the cumulative check engages at 12, but it
    // must NOT kill cold: occurrences 12/13/14 nudge, and 15 stops. A
    // same-key stop reached with nudges: 0 is the defect nax#2120 filed.
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };

    let stoppedAt: number | undefined;
    let nudges = 0;
    for (let i = 0; i < 50 && stoppedAt === undefined; i += 1) {
      const verdict = breaker.observe("RunCommand", KEY_A);
      if (verdict.action === "nudge") nudges += 1;
      if (verdict.action === "stop") stoppedAt = i + 1;
    }

    expect(stoppedAt).toBe(15);
    expect(nudges).toBe(3);
  });
```

(d) Task 1's own `"a cumulative stop resets that key's count..."` — its first stop moves from 12 to 15, because the ladder is now spent first. The *second* stop stays at the 12th post-reset occurrence, because `nudges` is already at `maxNudges` by then so `stopOrNudge` no longer downgrades. Change only the first expectation:

```typescript
    expect(firstStopAt).toBe(15);
```

and raise its loop bound from `i < 12` to `i < 20` so the stop is reachable. The `"a stop does not turn the key into a new-key event"` test needs its `for (let i = 0; i < 12; ...)` seeding loop raised to `i < 15` for the same reason.

- [ ] **Step 2: Write the new failing test**

Append inside the same `describe` block:

```typescript
  // nax#2120 defect 1: for a loop over 1-2 already-seen keys the first nudge
  // point (25) was unreachable, because the cumulative stop returned before
  // repeatsSinceProgress was incremented. The invariant is now in the
  // mechanism: no config can produce a stop with nudges: 0.
  test("never stops with nudges unspent, for any cycle length", () => {
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };
    const KEY_C = { command: "testScoped", values: { files: "c.test.ts" } };
    const cycles: ReadonlyArray<readonly unknown[]> = [[KEY_A], [KEY_A, KEY_B], [KEY_A, KEY_B, KEY_C]];

    for (const cycle of cycles) {
      const breaker = createSpinBreaker(settings());
      let stopped = false;
      for (let i = 0; i < 400 && !stopped; i += 1) {
        if (breaker.observe("RunCommand", cycle[i % cycle.length]).action === "stop") stopped = true;
      }
      expect(stopped).toBe(true);
      expect(breaker.summary().nudges).toBe(3);
    }
  });

  test("a downgraded stop does not consume the cumulative evidence", () => {
    // The Task 1 reset belongs to a REAL stop. If a nudge reset the count
    // too, the threshold could never be reached a second time and the loop
    // would nudge forever.
    const breaker = createSpinBreaker(settings());
    let stopped = false;
    for (let i = 0; i < 20 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
    }
    expect(stopped).toBe(true);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=5000`

Expected: FAIL. `never stops with nudges unspent` fails on the 1-key and 2-key cycles with `expected 3, received 0`. The three updated tests fail with `expected 15, received 12`.

- [ ] **Step 4: Write the implementation**

In `src/runtime/spin-breaker/index.ts`, change `buildNudge` to take `repeats` explicitly (it currently closes over `repeatsSinceProgress`, which is the wrong number for the cumulative path):

```typescript
  function buildNudge(toolName: string, repeats: number): SpinVerdict {
    nudges += 1;
    getSafeLogger()?.warn("spin-breaker", "Repeated calls with no progress — nudging", {
      tool: toolName,
      repeats,
      nudgeNumber: nudges,
      newKeyEvents,
    });
    return { action: "nudge", nudgeNumber: nudges, repeats, text: nudgeText(nudges, repeats) };
  }
```

Add directly below it:

```typescript
  /**
   * nax#2120: the escalation ladder must always render before a kill. The
   * nudge points are derived from `repeatsSinceProgress`, but the cumulative
   * per-key check runs on a different counter, so for a loop over 1-2
   * already-seen keys the first nudge point was unreachable by arithmetic
   * and the turn was killed cold with `nudges: 0`.
   *
   * Deliberately NOT a config refinement: reachability depends on the loop's
   * CYCLE LENGTH, not on the knobs, so no cross-field inequality can express
   * it. Spending a nudge instead costs at most `maxNudges` extra calls before
   * a genuine nax#2047 kill, and makes `nudges: 0` on a stop unreachable for
   * every configuration.
   *
   * `onStop` runs only when the verdict is a real stop — the Task 1 evidence
   * reset must not fire on a downgrade, or the threshold could never be
   * reached twice and the loop would nudge forever.
   */
  function stopOrNudge(
    toolName: string,
    repeats: number,
    reason: "repeat-run" | "same-key-cumulative",
    onStop?: () => void,
  ): SpinVerdict {
    if (nudges < settings.maxNudges) return buildNudge(toolName, repeats);
    onStop?.();
    getSafeLogger()?.error("spin-breaker", "Ending the turn — repeated calls with no progress", {
      tool: toolName,
      repeats,
      reason,
      newKeyEvents,
      totalCalls,
      nudges,
    });
    return { action: "stop", repeats, reason };
  }
```

Replace the cumulative stop block (as amended by Task 1) with:

```typescript
      if (settings.stopAfterSameKeyRepeats > 0 && cumulativeCount >= settings.stopAfterSameKeyRepeats) {
        return stopOrNudge(toolName, cumulativeCount, "same-key-cumulative", () => {
          // The stop consumes the evidence it fired on (nax#2120, Task 1).
          recent.set(key, 0);
        });
      }
```

Replace the repeat-run stop block (currently 211-221) with:

```typescript
      if (repeatsSinceProgress >= settings.stopAfterRepeats) {
        return stopOrNudge(toolName, repeatsSinceProgress, "repeat-run");
      }
```

And change the remaining nudge-point call site to pass its counter explicitly:

```typescript
      const isNudgePoint = points.includes(repeatsSinceProgress);
      if (isNudgePoint && nudges < settings.maxNudges) return buildNudge(toolName, repeatsSinceProgress);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=5000`

Expected: PASS. Check specifically that `escalates through maxNudges then stops` still reports `stoppedAt === 50` — it runs with `stopAfterSameKeyRepeats: 0` and already spends three nudges before 50, so `stopOrNudge` is a no-op downgrade for it.

- [ ] **Step 6: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`

Expected: all PASS. `test/unit/agents/native/turn-loop-spin.test.ts` drives the breaker through the real turn loop — if any case there asserts a stop at a specific call index, move it by 3 and note why in a comment.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/spin-breaker/index.ts test/unit/runtime/spin-breaker.test.ts test/unit/agents/native/turn-loop-spin.test.ts
git commit -m "fix(spin-breaker): never stop with the nudge ladder unspent

The cumulative per-key check returned stop before repeatsSinceProgress was
incremented, so for a loop over 1-2 already-seen keys the first nudge point
(25) was unreachable by arithmetic — a 1-key loop hit cumulative 12 at
repeatsSinceProgress 11. The escalation ladder was dead exactly where it is
most needed and NUDGE_ESCALATION never rendered in practice.

Enforced in the mechanism rather than as a config refinement: reachability
depends on the loop's cycle length, not on the knobs, so no cross-field
inequality can express it. Any stop downgrades to a nudge while nudges
remain; the condition must re-trip to end the turn.

Refs nax#2120"
```

---

### Task 3: Count a repeat only when the result did not change

The key is `tool + stableStringify(input)`, so re-running the same scoped test after each edit is one key whose count only rises. That is correct TDD behaviour. The module's own header says a session making varied calls "is working, not spinning", but the cumulative counter has no progress axis, so twelve legitimate edit-test iterations read identically to twelve idle re-runs. The killed session had `maxRepeatRun: 5` against a threshold of 50, `newKeyEvents: 67` of `totalCalls: 96`, and 17 `Edit` calls interleaved with the test re-runs.

The axis that separates the shapes is result identity — the thing `NUDGE_ESCALATION` already claims to measure ("the results are not changing"). #2013's verifier re-ran a *passing* test 622 times for byte-identical output; #2047's identical calls returned identical results; this loop's output went failing, to a different failure, to passing.

`observe()` runs pre-execution, so the breaker needs a second entry point fed after the tool answers.

**Files:**
- Modify: `src/runtime/spin-breaker/index.ts`
- Modify: `src/agents/native/session/turn-loop.ts:396-420`
- Test: `test/unit/runtime/spin-breaker.test.ts`
- Test: `test/unit/agents/native/turn-loop-spin.test.ts`

**Interfaces:**
- Consumes: `stopOrNudge(toolName, repeats, reason, onStop?)` from Task 2.
- Produces: `SpinBreaker` gains `noteResult(toolName: string, input: unknown, resultText: string): void`. The `recent` map's value type changes from `number` to `KeyRecord { count: number; sameResultRun: number; digest?: string }`. `SpinSummary` is unchanged — `maxSameKeyRepeats` continues to report the raw cumulative peak.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe` block in `test/unit/runtime/spin-breaker.test.ts`:

```typescript
  // nax#2120 defect 2: the cumulative counter had no progress axis, so an
  // edit -> re-run-scoped-test loop read identically to an idle re-run loop.
  // Result identity is the axis the nudge copy already claims to measure.
  test("an edit-test loop with changing results is never stopped", () => {
    const breaker = createSpinBreaker(settings());

    // 40 iterations of the shape that was killed: same scoped test command,
    // a different failure each time.
    for (let i = 0; i < 40; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      expect(verdict.action).not.toBe("stop");
      breaker.noteResult("RunCommand", TEST_CMD, `FAIL: expected ${i} to equal ${i + 1}`);
    }
  });

  test("identical results still stop, spending the ladder first", () => {
    const breaker = createSpinBreaker(settings());

    let stoppedAt: number | undefined;
    for (let i = 0; i < 40 && stoppedAt === undefined; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stoppedAt = i + 1;
      breaker.noteResult("RunCommand", TEST_CMD, "PASS 1 test, 0 failures");
    }

    // 16, not 15: `observe` runs pre-execution, so occurrence N's result is
    // only known when N+1 is judged. sameResultRun therefore lags the raw
    // count by exactly one call, and the whole ladder shifts with it.
    expect(stoppedAt).toBe(16);
  });

  test("durations and timestamps do not count as a changed result", () => {
    // A test runner prints an elapsed time on every run. Without
    // normalisation, byte-identical work reads as a changed result and the
    // whole check is defeated — this is the nax#2013 verifier's shape.
    const breaker = createSpinBreaker(settings());

    let stopped = false;
    for (let i = 0; i < 40 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
      breaker.noteResult("RunCommand", TEST_CMD, `\x1b[32mPASS\x1b[0m 1 test in ${1.2 + i * 0.01}s`);
    }

    expect(stopped).toBe(true);
  });

  test("a changed failure count IS a changed result", () => {
    // The normaliser must strip duration/timestamp tokens only. Blanking all
    // digits would mask "2 failed" -> "1 failed", which is real progress.
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 40; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      expect(verdict.action).not.toBe("stop");
      breaker.noteResult("RunCommand", TEST_CMD, `FAIL ${40 - i} failed in 1.20s`);
    }
  });

  test("the raw backstop still fires when results never repeat", () => {
    // A call whose result is unique every time (a clock read, a random id)
    // must not be immortal: stopAfterRepeats bounds the raw cumulative count.
    const breaker = createSpinBreaker(settings());

    let stopped = false;
    for (let i = 0; i < 120 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
      breaker.noteResult("RunCommand", TEST_CMD, `unique-${i}-${i * 7}`);
    }

    expect(stopped).toBe(true);
    expect(breaker.summary().nudges).toBe(3);
  });

  test("a key with no noted result falls back to the raw count", () => {
    // Denied and errored calls never reach noteResult. They must still be
    // bounded, on the raw backstop rather than the result axis.
    const breaker = createSpinBreaker(settings());

    let stopped = false;
    for (let i = 0; i < 120 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
    }

    expect(stopped).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=5000`

Expected: FAIL with `breaker.noteResult is not a function`.

- [ ] **Step 3: Implement the result axis**

In `src/runtime/spin-breaker/index.ts`, add to the `SpinBreaker` interface:

```typescript
export interface SpinBreaker {
  observe(toolName: string, input: unknown): SpinVerdict;
  /**
   * Feed back what a call returned. `observe` runs pre-execution, so the
   * result of occurrence N is only known when occurrence N+1 is judged —
   * that one-call lag is intentional and harmless at these thresholds.
   * Calls that are denied or throw never reach here; those keys fall back
   * to the raw backstop inside `observe`.
   */
  noteResult(toolName: string, input: unknown, resultText: string): void;
  summary(): SpinSummary;
}
```

Add the normaliser next to `stableStringify`. ANSI stripping is delegated to the existing `stripControlChars` — a regex literal containing `\x1b` is rejected by `lint/suspicious/noControlCharactersInRegex`, and that util is the one place in the repo licensed to waive the rule:

```typescript
import { stripControlChars } from "@/utils/strip-control-chars";
```
```typescript
/**
 * Strips the tokens that differ between two byte-identical runs: elapsed
 * times and clock timestamps (ANSI escapes are removed by
 * `stripControlChars` first). Deliberately surgical rather than blanking
 * every digit — "2 failed" -> "1 failed" is real progress and must survive
 * normalisation, while "in 1.20s" -> "in 1.23s" must not.
 */
const DURATION_OR_TIMESTAMP =
  /\b\d+(?:\.\d+)?\s?(?:ms|s|m|min)\b|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b|\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;

function resultDigest(text: string): string {
  const normalised = stripControlChars(text).replace(DURATION_OR_TIMESTAMP, "").replace(/\s+/g, " ").trim();
  return String(Bun.hash(normalised));
}
```

Change the window's value type and the counters:

```typescript
interface KeyRecord {
  /** Raw cumulative occurrences — the backstop, and what `summary` reports. */
  count: number;
  /** Consecutive occurrences whose result digest was unchanged. */
  sameResultRun: number;
  digest?: string;
}
```
```typescript
  const recent = new Map<string, KeyRecord>();
```

`remember` becomes:

```typescript
  function remember(key: string): void {
    recent.set(key, { count: 1, sameResultRun: 0 });
    newKeyEvents += 1;
    if (recent.size > settings.recentKeyWindow) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
  }
```

The repeat branch of `observe` becomes:

```typescript
      const record = recent.get(key) ?? { count: 0, sameResultRun: 0 };
      record.count += 1;
      recent.set(key, record);
      if (record.count > maxSameKeyRepeats) maxSameKeyRepeats = record.count;

      // nax#2120: the cumulative threshold now runs on the RESULT axis. Same
      // call + same result N times is a spin whatever interleaved; same call
      // with a changing result is an edit -> test loop, which is work. The
      // raw count is kept as a backstop for a call whose result is unique
      // every time, or which never reaches `noteResult` (denied, threw) —
      // `stopAfterRepeats` bounds it without adding a knob.
      if (settings.stopAfterSameKeyRepeats > 0 && record.sameResultRun >= settings.stopAfterSameKeyRepeats) {
        return stopOrNudge(toolName, record.sameResultRun, "same-key-cumulative", () => {
          record.count = 0;
          record.sameResultRun = 0;
        });
      }
      if (settings.stopAfterSameKeyRepeats > 0 && record.count >= settings.stopAfterRepeats) {
        return stopOrNudge(toolName, record.count, "same-key-cumulative", () => {
          record.count = 0;
          record.sameResultRun = 0;
        });
      }
```

Add `noteResult` to the returned object, above `summary`:

```typescript
    noteResult(toolName, input, resultText) {
      if (!settings.enabled) return;
      const record = recent.get(callKey(toolName, input));
      if (record === undefined) return;
      const digest = resultDigest(resultText);
      record.sameResultRun = record.digest === digest ? record.sameResultRun + 1 : 1;
      record.digest = digest;
    },
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `bun test test/unit/runtime/spin-breaker.test.ts --timeout=5000`

Expected: PASS, after the following updates. Every test that drives a repeat without calling `noteResult` now rides the raw backstop (`stopAfterRepeats`, 50) instead of the result axis, so its index moves. Feed results and re-derive:

- `stops at the 12th occurrence of one key regardless of what came between` — add `breaker.noteResult("RunCommand", KEY_A, "identical")` after each `observe` (and the `KEY_B` equivalent). Its expectation moves from the 15 set in Task 2 to **16**, for the one-call lag above.
- `interleaving does not reset the cumulative counter` — add the same two `noteResult` calls. Its expectation moves from the 26 set in Task 2 to **28**.
- Task 1's `a cumulative stop resets that key's count...` — add `breaker.noteResult("RunCommand", TEST_CMD, "identical")` after each `observe` in both loops, but **only when the verdict was not a stop**: a stopped call is never executed, so it never produces a result, and feeding one would not match production. `firstStopAt` moves from 15 to **16**, and the post-reset second stop moves from the 12th occurrence to the **13th** — the same one-call lag applies again after the reset, because `sameResultRun` restarts at 0.
- `a stop does not turn the key into a new-key event` — same `noteResult` addition; raise the seeding loop to `i < 16`.
- The 120-call `1789376162585-US-001-implementer` sequence test — feed a constant result string for `KEY_A` and for `KEY_B`, and a per-path unique string for the distinct `Read`s. It still stops (simulated: at call 30 of 120), so keep its `expect(stopped).toBe(true)` as is.

If any index here disagrees with what the run prints, trust the run and fix the plan — but re-read the algorithm first, because a disagreement most likely means the implementation drifted from what was simulated.

- [ ] **Step 5: Wire noteResult into the turn loop**

In `src/agents/native/session/turn-loop.ts`, after the denial `messages.push` (currently ending line 413) and after the normal `messages.push` (ending line 420), feed the result back. Insert immediately before `continue;` in the denial branch:

```typescript
            spinBreaker?.noteResult(call.name, call.input, answer.answer);
```

and immediately after the normal `messages.push({...})` block:

```typescript
          spinBreaker?.noteResult(call.name, call.input, answerText);
```

A thrown tool call is deliberately NOT fed back: the catch block's message is an error string, not a result, and letting an error digest count toward `sameResultRun` would make a persistently failing tool look like a spin.

- [ ] **Step 6: Extend the test fixture, then write the turn-loop integration test**

`test/unit/agents/native/turn-loop-spin.test.ts` drives the real `runNativeTurn` through one local helper, `runTurnWithSpin({ complete, spinBreaker, onToolResult })`. There is no `openNativeSession`/`opts`/`sendOpts`/`deps` in this file — the handle (`sess-spin`) and the transcript dir are module-level, set up in `beforeEach`.

Its `interactionHandler` answers **every** call with the fixed string `"29 tests passed"`, which cannot express a changing result. Extend `RunTurnWithSpinOpts` with an optional answer callback, defaulting to today's constant so every existing test is unaffected:

```typescript
interface RunTurnWithSpinOpts {
  complete: TurnDeps["complete"];
  spinBreaker: TurnDeps["spinBreaker"];
  onToolResult?: (content: string) => void;
  /** Per-call tool answer. Defaults to the constant every existing test relies on. */
  answer?: () => string;
}
```

and inside `runTurnWithSpin`:

```typescript
  const interactionHandler: SendTurnOpts["interactionHandler"] = {
    onInteraction: async () => ({ answer: opts.answer?.() ?? "29 tests passed" }),
  };
```

Then add the test:

```typescript
  test("a model that edits and re-runs the same scoped test is not stopped (nax#2120)", async () => {
    // The shape of run-2026-09-17T11-43-47-190Z US-001: one RunCommand key
    // re-run after each edit, with a different failure each time. 40
    // iterations, well past stopAfterSameKeyRepeats=12.
    let call = 0;
    let answered = 0;
    const result = await runTurnWithSpin({
      complete: async () => {
        call += 1;
        if (call > 40) return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      answer: () => {
        answered += 1;
        return `FAIL: expected ${answered} to equal ${answered + 1}`;
      },
      spinBreaker: createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS),
    });

    expect(result.spinStopped).toBeUndefined();
    expect(result.output).toBe("done");
  });
```

Note this test uses the shipped defaults, unlike the three existing tests in the file which shrink the thresholds. That is deliberate: the defect was reported against the defaults.

- [ ] **Step 7: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/spin-breaker/index.ts src/agents/native/session/turn-loop.ts test/unit/runtime/spin-breaker.test.ts test/unit/agents/native/turn-loop-spin.test.ts
git commit -m "fix(spin-breaker): count a repeat only when the result did not change

The cumulative per-key counter had no progress axis, so twelve legitimate
edit -> re-run-scoped-test iterations read identically to twelve idle
re-runs. The killed session had maxRepeatRun 5 against a threshold of 50,
67 of 96 calls new, and 17 interleaved Edit calls.

Result identity is the axis NUDGE_ESCALATION already claims to measure:
same call plus same result N times is a spin whatever interleaved, while
same call with a changing result is an edit-test loop. Deliberately NOT the
mutating-tool exemption originally suggested — editing an unrelated file
between identical calls would launder past that, which is cheaper than the
interleaving nax#2047 was hardened against.

The raw cumulative count is kept as a backstop at stopAfterRepeats for
calls whose result is unique every time or which never reach noteResult.

Refs nax#2120"
```

---

### Task 4: End a spun turn with an answer, not a hole

The stop path sets `spinStopped` and breaks, leaving the triggering call unexecuted and unanswered — producing `native-adapter: turn ended with tool calls outstanding`. `call-hop-output.ts:49-64` then classifies it `fail-spin`, and `failure-policy.ts:104-110` puts it on the `timeout` lane, whose contract is "same agent, FRESH session (so the repeating transcript is dropped) at a reduced budget". For a false positive that discards the turn's entire accumulated working state and restarts on less budget. It also burns `timeoutRetryAttempts`, a counter shared with `fail-timeout` and `fail-incomplete`.

Give the model one terminal round trip: answer every outstanding call in the batch with the final warning, let it produce its answer, and only stop hard if it asks for more tools. This also makes `NUDGE_ESCALATION[2]`'s promise ("The next repeated call ends this session with no answer recorded") true rather than aspirational.

**Files:**
- Modify: `src/runtime/spin-breaker/index.ts` — export the terminal copy
- Modify: `src/runtime/index.ts` — re-export it
- Modify: `src/agents/native/session/turn-loop.ts:389-395`
- Test: `test/unit/agents/native/turn-loop-spin.test.ts`

**Interfaces:**
- Consumes: `SpinVerdict` with `action: "stop"` from Tasks 1-3.
- Produces: exported `const SPIN_TERMINAL_NOTICE: string` from `src/runtime/spin-breaker/index.ts`, re-exported through `src/runtime/index.ts` alongside `createSpinBreaker`.

- [ ] **Step 1: Write the failing test**

In `test/unit/agents/native/turn-loop-spin.test.ts`:

Use the same `runTurnWithSpin` helper as Task 3 (no `openNativeSession`/`opts`/`deps` exist in this file). `complete` receives `(messages, tools)` per `TurnDeps` in `src/agents/native/session/turn-types.ts:53`, so the model stub can see the notice:

```typescript
  test("a spun turn gets one terminal round trip to produce an answer (nax#2120)", async () => {
    let call = 0;
    const result = await runTurnWithSpin({
      complete: async (messages) => {
        call += 1;
        const warned = messages.some(
          (m) => typeof m.content === "string" && m.content.includes("This turn is ending"),
        );
        // The model answers as soon as it is told the turn is ending.
        if (warned) return { text: "final answer", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 3,
        stopAfterRepeats: 6,
        maxNudges: 1,
      }),
    });

    expect(result.output).toBe("final answer");
    expect(result.spinStopped).toBeUndefined();
    expect(result.turnIncomplete).toBeUndefined();
  });

  test("a model that keeps calling tools after the terminal notice is stopped hard", async () => {
    let call = 0;
    const result = await runTurnWithSpin({
      complete: async () => {
        call += 1;
        return {
          text: "",
          toolCalls: [{ id: `c${call}`, name: "RunCommand", input: { command: "testScoped" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0,
        };
      },
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 3,
        stopAfterRepeats: 6,
        maxNudges: 1,
      }),
    });

    expect(result.spinStopped).toBe(true);
  });
```

The shrunk thresholds match the two existing tests in this file, which keeps the round-trip count small enough for the transcript assertions there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/agents/native/turn-loop-spin.test.ts --timeout=5000`

Expected: FAIL. The first test gets `spinStopped: true` and no output, because the current path breaks without answering.

- [ ] **Step 3: Export the terminal copy**

In `src/runtime/spin-breaker/index.ts`, below `NUDGE_ESCALATION`:

```typescript
/**
 * Answered to every outstanding call when the breaker first decides to end a
 * turn (nax#2120). The stop used to break with the call unexecuted and
 * unanswered, so the turn was classified `fail-spin` and retried on the
 * timeout lane — a FRESH session at a reduced budget, discarding everything
 * the turn had accumulated. One terminal round trip lets the model close out
 * instead, and makes NUDGE_ESCALATION's final warning literally true.
 */
export const SPIN_TERMINAL_NOTICE =
  "[nax] This turn is ending: you repeated the same call with no change in its result. " +
  "This call was not executed. Produce your final answer now, in the exact format your " +
  "instructions require. Any further tool call ends the turn with no answer recorded.";
```

Add it to the export list in `src/runtime/index.ts` beside `createSpinBreaker`.

- [ ] **Step 4: Implement the terminal round trip**

In `src/agents/native/session/turn-loop.ts`, add beside `let spinStopped = false;` (line 112):

```typescript
  // nax#2120: the first stop verdict spends a terminal round trip rather than
  // tearing the turn down, so a false positive does not cost the transcript.
  let spinWarned = false;
```

Replace the stop branch (389-395) with:

```typescript
          if (verdict.action === "stop") {
            if (spinWarned) {
              spinStopped = true;
              // Second stop: the model ignored the notice. The call is
              // deliberately NOT executed and NOT answered — the turn is over
              // and a tool-result nobody will read only grows the transcript
              // the retry drops anyway.
              break;
            }
            spinWarned = true;
            // Every outstanding call in THIS batch is answered, not just the
            // triggering one: the next `complete()` would otherwise be sent a
            // tool_call with no matching result, which strict providers reject.
            for (const outstanding of res.toolCalls.slice(res.toolCalls.indexOf(call))) {
              messages.push({
                role: "tool-result",
                toolCallId: outstanding.id,
                content: SPIN_TERMINAL_NOTICE,
                isError: true,
              });
            }
            break;
          }
```

Import `SPIN_TERMINAL_NOTICE` from `@/runtime/spin-breaker` at the top of the file. `res.toolCalls` is the array the enclosing loop iterates (`turn-loop.ts:345`), and it is non-undefined inside the loop because line 340 returns early when it is empty.

`spinStopped` stays unset on the warning path, so the existing `if (spinStopped) break;` after the loop lets the outer round-trip loop continue and call `complete()` once more.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/agents/native/turn-loop-spin.test.ts --timeout=5000`

Expected: PASS.

- [ ] **Step 6: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`

Expected: all PASS. `bun run lint:checks` includes `check:file-sizes` — `turn-loop.ts` goes from 506 to roughly 530 lines, under the 600 limit.

Two existing tests in `turn-loop-spin.test.ts` each gain one round trip from the terminal notice. `ends the turn with spinStopped once the breaker stops it` asserts `internalRoundTrips` is `< 10` and should land around 8 — if it does not, report the actual number rather than widening the bound, because a larger jump means the warning path is looping instead of spending exactly one extra trip.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/spin-breaker/index.ts src/runtime/index.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop-spin.test.ts
git commit -m "fix(spin-breaker): end a spun turn with an answer, not a hole

The stop path left the triggering call unexecuted and unanswered and broke,
so the turn was classified fail-spin and retried on the timeout lane — same
agent, FRESH session, reduced budget. For a false positive that discards
the turn's entire accumulated working state and burns a retry from a budget
shared with fail-timeout and fail-incomplete.

The first stop verdict now answers every outstanding call in the batch with
a terminal notice and spends one more round trip, so the model can close
out. A further tool call ends the turn hard, exactly as NUDGE_ESCALATION's
final warning already promised.

Refs nax#2120"
```

---

## Verification against the field evidence

After all four tasks:

```bash
bun run test
bun run typecheck
bun run lint
```

Then re-read `tool-audit/glob-directory-grouped-output/1789645832213-US-001-implementer.json` and confirm the sequence it records — one `RunCommand{testScoped, glob.test.ts}` key re-run across 17 interleaved `Edit` calls — is covered by the Task 3 integration test's shape. If the audit shows the scoped test returning identical output on some consecutive pairs (a re-run with no effective edit), count the longest run of consecutive identical results; if it ever reaches 12, `stopAfterSameKeyRepeats` needs raising and that is a separate, evidence-backed change rather than part of this plan.
