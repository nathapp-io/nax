# Compaction Input-Class Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proactive context compaction fire under prompt caching by counting cache-read and cache-write tokens as part of the context anchor.

**Architecture:** The native turn loop anchors its context estimate on what the provider reported for the prompt, then estimates only the messages that follow. Under prompt caching the provider reports the cached prefix in separate cache fields, so anchoring on `inputTokens` alone under-reports the context by orders of magnitude. The fix extracts the existing "input-class tokens" summation into one shared helper and uses it at both sites that need it.

**Tech Stack:** TypeScript, Bun, `bun:test`.

**Spec:** [nax#1852](https://github.com/nathapp-io/nax/issues/1852). Background design doc: `docs/superpowers/specs/2026-09-04-native-context-compaction-design.md`.

## Global Constraints

- **Test commands** (`.nax/rules/testing-commands.md`):
  - Full suite: `bun run test`. It does **not** accept path arguments — `scripts/run-tests.ts` reads `argv` only for `--bail` and always runs the three fixed phase dirs, so `bun run test -- <path>` silently runs all ~15,800 tests.
  - Scoped iteration: `timeout 30 bun test <path> --timeout=5000`. The `timeout` wrapper is **mandatory**, not decoration — `--timeout` bounds each test, not the invocation, and Bun's JSC occasionally hangs or SIGABRTs, leaking grandchild processes.
  - Never an uncapped bare `bun test`.
- Quality gates: `bun run test`, `bun run typecheck`, `bun run lint`. Note `lint:json` does **not** run `check:file-sizes`; the full `bun run lint` does.
- File size budget: 600 lines for `src/`, 800 for `test/`. Current: `turn-loop.ts` 455, `calculate.ts` 197, `compaction.ts` 211, `turn-loop-compaction.test.ts` 446, `calculate.test.ts` 287. All have headroom.
- **Never create standalone bug-fix test files.** Add tests to the existing relevant file (`.nax/rules/test-architecture.md`, Placement Rule 2).
- Prefer the barrel (`@/agents/cost`) over an internal path when the symbol is exported from it.
- Field names differ across the boundary and must not be mixed up:

  | | input | cache read | cache write |
  |---|---|---|---|
  | nax-ai (`NativeUsage`) | `inputTokens` | `cacheReadTokens` | `cacheWriteTokens` |
  | **nax (`TokenUsage`)** | `inputTokens` | **`cacheReadInputTokens`** | **`cacheCreationInputTokens`** |

  Everything in this plan operates on the **nax** shape. `toNaxTokenUsage` (`src/agents/native/models.ts:113`) is the bridge.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/agents/cost/calculate.ts` | Token/cost computations over `TokenUsage` | Add `inputClassTokens` |
| `src/agents/cost/index.ts` | Barrel for `@/agents/cost` | Export `inputClassTokens` |
| `src/agents/native/models.ts` | Native model resolution, rates, cost | `selectRates` uses the helper |
| `src/agents/native/session/turn-loop.ts` | Native turn orchestration + compaction trigger | Anchor uses the helper |
| `src/agents/native/session/session.ts` | Session-scoped module maps | Anchor field rename (Task 3) |
| `src/agents/native/session/compaction.ts` | Pure compaction math | Anchor param rename + correct the false doc comment (Task 3) |

Tasks 1 and 2 are the fix. Task 3 is the recurrence guard — a reviewer can reject it independently without losing the fix.

---

### Task 1: Extract the input-class token helper

The bug is a drift between two places that both need "input-class tokens", only one of which was right. Extracting it first means Task 2 has one correct definition to call.

**Files:**
- Modify: `src/agents/cost/calculate.ts`
- Modify: `src/agents/cost/index.ts:1-8` (the first `export {}` block)
- Modify: `src/agents/native/models.ts:163-175` (`selectRates`)
- Test: `test/unit/agents/cost/calculate.test.ts`

**Interfaces:**
- Consumes: `TokenUsage` from `@/agents/cost` — `{ inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }` (`src/agents/cost/types.ts:16`).
- Produces: `inputClassTokens(usage: TokenUsage): number` — exported from `@/agents/cost`. Task 2 calls this.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/cost/calculate.test.ts`. Add `inputClassTokens` to the existing import from `@/agents/cost`.

Two tests, because the helper has two distinct jobs: summing the cache classes, and *not* summing output.

```typescript
describe("inputClassTokens", () => {
  test("sums input with cache reads and cache writes", () => {
    expect(
      inputClassTokens({
        inputTokens: 16,
        outputTokens: 900,
        cacheReadInputTokens: 71_755,
        cacheCreationInputTokens: 12_368,
      }),
    ).toBe(84_139);
  });

  test("treats absent cache fields as zero", () => {
    expect(inputClassTokens({ inputTokens: 500, outputTokens: 900 })).toBe(500);
  });

  test("excludes output tokens", () => {
    // Output is never part of the prompt the provider charged for. Asserted
    // explicitly because nax-ai's totalTokens() does include it, and reaching
    // for that helper here would double-count against the trailing estimate.
    expect(inputClassTokens({ inputTokens: 10, outputTokens: 10_000 })).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/agents/cost/calculate.test.ts --timeout=5000`
Expected: FAIL — `inputClassTokens` is not exported from `@/agents/cost`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/agents/cost/calculate.ts`:

```typescript
/**
 * Tokens the provider counted as part of the prompt.
 *
 * Cache reads and writes are prompt tokens that the provider reports
 * separately because it prices them differently — not tokens that were
 * absent from the request. Any consumer asking "how big was the prompt"
 * needs all three; `inputTokens` alone answers a different question and,
 * under prompt caching, collapses to near zero (nax#1852).
 *
 * Output is deliberately excluded: this measures the prompt, not the call.
 */
export function inputClassTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}
```

`calculate.ts:8` already imports `TokenUsage` from `./types` — no import change is needed in this file.

Add to the first export block in `src/agents/cost/index.ts`, keeping the list alphabetical:

```typescript
export {
  addTokenUsage,
  estimateCost,
  estimateCostByDuration,
  estimateCostFromTokenUsage,
  formatCostWithConfidence,
  inputClassTokens,
  resolvePricingSource,
} from "./calculate";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/agents/cost/calculate.test.ts --timeout=5000`
Expected: PASS

- [ ] **Step 5: Use the helper in `selectRates`**

In `src/agents/native/models.ts`, line 10 is currently `import type { TokenUsage } from "@/agents/cost";`. Replace it with the repo's merged type+value form (biome runs `organizeImports`, and this is the established style — see `src/tools/runtime.ts:19`, `src/context/engine/rebuild.ts:24`). **Member order matters:** biome sorts case-insensitively by name and ignores the `type` keyword, so `inputClassTokens` (i) sorts before `TokenUsage` (t). The reverse order fails `bun run lint`:

```typescript
import { inputClassTokens, type TokenUsage } from "@/agents/cost";
```

**This turns a type-only import into a value import**, adding a real edge to the runtime graph that `check:import-cycles` inspects. It is safe: nothing under `src/agents/cost/` imports from `@/agents/*`, and its one relative import — `calculate.ts:6` → `../model-spec` — is a leaf module with zero imports of its own. `models.ts:14` already depends on `../model-spec` anyway.

Then replace the inline summation in `selectRates`:

```typescript
  const totalInputTokens = inputClassTokens(usage);
```

This replaces exactly these two lines:

```typescript
  const totalInputTokens =
    usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
```

- [ ] **Step 6: Run the native model tests to confirm no behaviour change**

Run: `timeout 30 bun test test/unit/agents/native/models.test.ts test/unit/agents/cost/calculate.test.ts --timeout=5000`
Expected: PASS. This is a pure refactor — the expression is byte-identical, so any failure means the extraction is wrong.

- [ ] **Step 7: Commit**

```bash
git add src/agents/cost/calculate.ts src/agents/cost/index.ts src/agents/native/models.ts test/unit/agents/cost/calculate.test.ts
git commit -m "refactor(cost): extract inputClassTokens and use it in selectRates"
```

---

### Task 2: Fix the compaction anchor

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts:298-300`
- Test: `test/unit/agents/native/turn-loop-compaction.test.ts`

**Interfaces:**
- Consumes: `inputClassTokens` from `@/agents/cost` (Task 1).
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Append to the `describe("proactive compaction")` block in `test/unit/agents/native/turn-loop-compaction.test.ts`. The harness, `handle`, `cfg`, `opts`, `usage`, `dir` and the `afterEach` that clears `nativeSessionLastUsage` already exist at the top of that file — reuse them.

**Transcript sizing is load-bearing — read this before writing the test.** Three constraints must hold simultaneously, or the test proves nothing:

| | value | why |
|---|---|---|
| threshold | `min(floor(20000×0.90), 20000−4096)` = **15,904** | what the estimate must exceed |
| `keepBudget` | `floor(20000×0.30)` = **6,000** | recent tokens kept verbatim |
| seeded transcript | ≈ **9,000** tokens | must be **under** 15,904 so round 1 does *not* compact, and **over** 6,000 so there is something left to cut |

That last column is the trap. `prepareCompaction` returns `undefined` when `cutIndex <= spanStart` (`compaction.ts:193`) — with a near-empty transcript the threshold trips but there is nothing to summarize, `summarizeCalls` stays 0, and the test fails *even against a correct fix*. Three 12,000-character messages (3,000 tokens each) satisfy all three constraints.

Returning `toolCalls` is what forces the second round trip — the established pattern in `turn-loop.test.ts:197,223,256`.

Write **two** tests. The second is a negative control: same transcript, same everything, cache tokens removed. It must show that the transcript alone does not trigger compaction — otherwise the first test could pass for the wrong reason.

```typescript
  /** Big enough to leave something to summarize, small enough not to trip the
   *  threshold on its own. See the sizing table in the plan. */
  async function seedCompactableTranscript() {
    await saveTranscript(dir, "sess-c", [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(12_000) },
      { role: "user", content: "b".repeat(12_000) },
      { role: "assistant", content: "c".repeat(12_000) },
    ]);
  }

  test("counts cached prompt tokens toward the compaction threshold", async () => {
    // Regression for nax#1852. The provider serves a cached prefix, so it
    // reports 16 uncached input tokens and 71,755 cache reads. Anchoring on
    // inputTokens alone reads that 71,771-token prompt as ~16, and compaction
    // never fires even though the prompt is 4x the window.
    await seedCompactableTranscript();
    let summarizeCalls = 0;
    let completeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 20_000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "summary", usage, costUsd: 0 };
      },
      complete: async () => {
        completeCalls += 1;
        if (completeCalls === 1) {
          // Sets the anchor. The tool call forces a second round trip, whose
          // pre-flight check is the assertion point.
          return {
            text: "working",
            toolCalls: [{ id: "c1", name: "t", input: {} }],
            usage: { inputTokens: 16, outputTokens: 5, cacheReadInputTokens: 71_755 },
            costUsd: 0,
          };
        }
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(completeCalls).toBe(2);
    expect(summarizeCalls).toBe(1);
  });

  test("does not compact when the same transcript reports no cached tokens", async () => {
    // Negative control for the test above. Identical in every respect except
    // that the prompt was not cached, so the anchor is genuinely small. If this
    // one also compacts, the test above is passing on transcript size rather
    // than on the cache accounting, and proves nothing.
    await seedCompactableTranscript();
    let summarizeCalls = 0;
    let completeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 20_000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "summary", usage, costUsd: 0 };
      },
      complete: async () => {
        completeCalls += 1;
        if (completeCalls === 1) {
          return {
            text: "working",
            toolCalls: [{ id: "c1", name: "t", input: {} }],
            usage: { inputTokens: 16, outputTokens: 5 },
            costUsd: 0,
          };
        }
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(completeCalls).toBe(2);
    expect(summarizeCalls).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 30 bun test test/unit/agents/native/turn-loop-compaction.test.ts --timeout=5000`

Expected, and both halves matter:
- `counts cached prompt tokens toward the compaction threshold` → **FAIL**, `expect(summarizeCalls).toBe(1)` receives `0`. Compaction never fires because the anchor reads 16.
- `does not compact when the same transcript reports no cached tokens` → **PASS** already (it asserts 0, which is what current code does).

**The first failure is the whole point of the task.** If it passes before the fix, the test is not exercising the anchor — stop and fix the test rather than proceeding.

If the *control* fails (summarize was called with no cache tokens), the seeded transcript is too large and is tripping the threshold on its own — shrink the three messages until it passes, keeping them above the 6,000-token keep budget.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/native/session/turn-loop.ts`, line 11 is currently `import type { TokenUsage } from "@/agents/cost";`. Replace it with the merged form (same convention as Task 1):

```typescript
import { inputClassTokens, type TokenUsage } from "@/agents/cost";
```

Replace lines 298-300:

```typescript
      lastUsage = { inputTokens: res.usage.inputTokens };
      anchorIndex = messages.length - 1;
      nativeSessionLastUsage.set(handle.id, { inputTokens: res.usage.inputTokens, anchorIndex });
```

with:

```typescript
      // nax#1852: the anchor is the whole prompt the provider charged for, not
      // just its uncached portion. Under prompt caching (which the round trip
      // above always requests) the cached prefix arrives in the cache fields,
      // and counting inputTokens alone reads a 71k-token context as ~16.
      const promptTokens = inputClassTokens(res.usage);
      lastUsage = { inputTokens: promptTokens };
      anchorIndex = messages.length - 1;
      nativeSessionLastUsage.set(handle.id, { inputTokens: promptTokens, anchorIndex });
```

Leave the running `cacheReadInputTokens` / `cacheCreationInputTokens` accumulators at lines 289-294 untouched — they feed the turn's reported usage, which is a different concern.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 30 bun test test/unit/agents/native/turn-loop-compaction.test.ts --timeout=5000`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: PASS. Pay attention to `test/unit/agents/native/compaction.test.ts` and `session-lifecycle.test.ts` — they touch the same anchor.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop-compaction.test.ts
git commit -m "fix(native): count cached prompt tokens toward the compaction threshold

Closes #1852"
```

---

### Task 3: Rename the anchor field and correct its doc comment

The field is named `inputTokens` but now holds input-class totals, and `compaction.ts:68-74` documents a premise that is false under caching. That comment is what made the bug invisible — leaving it invites the exact same regression.

A reviewer may reject this task on its own; Tasks 1-2 are complete and correct without it.

**Files:**
- Modify: `src/agents/native/session/session.ts:78`
- Modify: `src/agents/native/session/turn-loop.ts:159-160, 298-300`
- Modify: `src/agents/native/session/compaction.ts:68-88`
- Test: `test/unit/agents/native/compaction.test.ts`, `test/unit/agents/native/session-lifecycle.test.ts:340`

**Interfaces:**
- Consumes: nothing new.
- Produces: `estimateContextTokens(messages, lastUsage?: { promptTokens: number }, anchorIndex?)` — the second parameter's property is renamed from `inputTokens` to `promptTokens`. `nativeSessionLastUsage` becomes `Map<string, { promptTokens: number; anchorIndex: number }>`.

- [ ] **Step 1: Update the type declarations**

`src/agents/native/session/session.ts:78`:

```typescript
export const nativeSessionLastUsage = new Map<string, { promptTokens: number; anchorIndex: number }>();
```

`src/agents/native/session/compaction.ts` — replace the `estimateContextTokens` doc comment and signature:

```typescript
/**
 * Anchor on truth, guess only the tail.
 *
 * `lastUsage.promptTokens` is every token the provider counted for the prompt
 * up to and including `anchorIndex` — uncached input plus cache reads plus
 * cache writes (see `inputClassTokens`). It is deliberately not just the
 * uncached input: under prompt caching the cached prefix is reported
 * separately, and anchoring on that one field reads a 71k-token context as
 * ~16 and silently disables compaction (nax#1852).
 *
 * With no anchor every message is estimated, which is the case the reactive
 * backstop exists to cover.
 */
export function estimateContextTokens(
  messages: readonly TranscriptMessage[],
  lastUsage?: { readonly promptTokens: number },
  anchorIndex?: number,
): number {
  if (lastUsage === undefined || anchorIndex === undefined) {
    return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  }
  let trailing = 0;
  for (let i = anchorIndex + 1; i < messages.length; i++) trailing += estimateTokens(messages[i] as TranscriptMessage);
  return lastUsage.promptTokens + trailing;
}
```

- [ ] **Step 2: Update the call sites**

`src/agents/native/session/turn-loop.ts:159-160`:

```typescript
  const anchor = nativeSessionLastUsage.get(handle.id);
  let lastUsage = anchor?.promptTokens !== undefined ? { promptTokens: anchor.promptTokens } : undefined;
```

`src/agents/native/session/turn-loop.ts` — the block written in Task 2 becomes:

```typescript
      const promptTokens = inputClassTokens(res.usage);
      lastUsage = { promptTokens };
      anchorIndex = messages.length - 1;
      nativeSessionLastUsage.set(handle.id, { promptTokens, anchorIndex });
```

The Task 2 comment above it stays.

- [ ] **Step 3: Update the tests**

`test/unit/agents/native/compaction.test.ts:46`:

```typescript
    expect(estimateContextTokens(messages, { promptTokens: 50 }, 1)).toBe(150);
```

`test/unit/agents/native/session-lifecycle.test.ts:340`:

```typescript
    nativeSessionLastUsage.set("sess-cfg2", { promptTokens: 10, anchorIndex: 0 });
```

- [ ] **Step 4: Run typecheck to catch any missed site**

Run: `bun run typecheck`
Expected: PASS. A missed `inputTokens` reference on the anchor is a type error — this is the check that the rename is complete.

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/session.ts src/agents/native/session/turn-loop.ts src/agents/native/session/compaction.ts test/unit/agents/native/compaction.test.ts test/unit/agents/native/session-lifecycle.test.ts
git commit -m "refactor(native): rename the compaction anchor field to promptTokens"
```

---

### Task 4: Verify against the live failure

Unit tests prove the arithmetic. They do not prove compaction fires on the production path — this feature has now shipped green twice while being inert in production, so a live run is the only evidence that counts.

**Files:** none — this task runs the built binary against a fixture.

- [ ] **Step 1: Run the quality gates**

```bash
bun run typecheck && bun run lint && bun run test
```
Expected: all PASS. `bun run lint` includes `check:file-sizes`, which `lint:json` does not.

- [ ] **Step 2: Build and confirm the binary is the branch build**

```bash
bun run build
```

Verify by commit, never by `--version` — a local build and the installed global canary report the same version string. The run log's `run.start` stamps `naxCommit`; check it matches `git rev-parse --short HEAD`.

- [ ] **Step 3: Run the fixture that exposed the bug**

Use the `native-full-run` fixture from `nax-context-dogfood`, from a **copy** (a nax run auto-commits into the working tree), with all three native tiers pinned to `anthropic/claude-sonnet-5` and `contextWindow: 20000`. Pass `--verbose` — a run-stage adapter error is otherwise unreachable (nax#1853).

```bash
bun <this-repo>/dist/nax.js plan --from spec.md -f session-tokens -d .
bun <this-repo>/dist/nax.js run  -f session-tokens -d . --headless --verbose
```

- [ ] **Step 4: Confirm compaction fired**

```bash
grep -c "compaction completed" run.log
```
Expected: **greater than 0**. The pre-fix baseline for this exact fixture and config is **0**, against sonnet calls whose true context was 48,642-71,771 tokens.

Also check `grep -c "no size progress" run.log`. A non-zero count is nax#1842 observed live — record it there; it does not block this fix.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin fix/compaction-input-class-anchor
gh pr create --fill
```

The PR body should carry the before/after `compaction completed` counts from Step 4 — that is the evidence the fix works where the unit tests cannot reach.

---

## Self-Review

**Spec coverage.** #1852 asks for three things: count cache tokens in the anchor (Task 2), extract the summation so the two sites cannot drift again (Task 1), and consider renaming the field so the premise stops being restated (Task 3). The issue's regression-test requirement — small `inputTokens`, large `cacheReadInputTokens`, assert compaction fires against a 20,000 window — is Task 2 Step 1. Task 4 covers the live verification the issue's evidence section rests on.

**Placeholder scan.** No TBDs. Every code step carries the literal text to write. The one conditional instruction (Task 2 Step 1, if `Read` does not force a second round trip) names the concrete fallback and states which part must not change.

**Type consistency.** `inputClassTokens(usage: TokenUsage): number` is defined in Task 1 and called in Tasks 1 and 2 under that exact name. Task 3 renames `inputTokens` → `promptTokens` on the anchor only, and updates all five sites plus both tests; `TokenUsage.inputTokens` itself is untouched. Cache field names are the nax spelling (`cacheReadInputTokens`, `cacheCreationInputTokens`) throughout, per Global Constraints.

## Review corrections (2026-09-05)

Four defects found reviewing this plan against the code, all fixed above. Recorded because the first would have cost real time:

1. **Task 2's test could not have passed even with a correct fix.** The original seeded a single tiny message. `prepareCompaction` returns `undefined` when `cutIndex <= spanStart` (`compaction.ts:193`), so the threshold would trip with nothing to summarize and `summarizeCalls` would stay 0. Replaced with a sized transcript and an explicit sizing table.
2. **No negative control.** The test could have passed on transcript size rather than cache accounting. Added a control asserting the same transcript does *not* compact without cache tokens.
3. **Import style was wrong.** Two separate imports from one module; the repo uses the merged `import { type X, y }` form and biome runs `organizeImports`.
4. **The plan's scoped test command did not scope.** `bun run test -- <path>` runs the entire ~15,800-test suite: `scripts/run-tests.ts` reads `argv` only for `--bail` and always iterates its three fixed phase dirs. Corrected to `timeout 30 bun test <path> --timeout=5000` throughout, per `.nax/rules/testing-commands.md` — the `timeout` wrapper is mandatory, since `--timeout` bounds each test rather than the invocation. *(Found by the Task 1 implementer, not by me.)*
5. **Import member order was backwards.** Biome sorts case-insensitively and ignores `type`, so it must be `{ inputClassTokens, type TokenUsage }`. *(Also found by the Task 1 implementer.)*
6. **A type-only → value import is a real graph edge.** `check:import-cycles` inspects value imports only. Verified safe rather than assumed: nothing under `src/agents/cost/` imports `@/agents/*`, and `calculate.ts:6`'s `../model-spec` is a leaf.
