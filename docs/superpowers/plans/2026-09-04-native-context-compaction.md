# Native Session Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the native turn loop from growing its conversation past the model's context window, by replacing the older span with a model-written summary once the conversation crosses a percentage of that window.

**Architecture:** A new pure-function module (`src/agents/native/session/compaction.ts`) owns estimation, the threshold, the cut point, and array rewriting — no I/O, no model calls, no clock. `turn-loop.ts` owns orchestration: it decides once per round trip whether to compact, calls a new `deps.summarize` seam for the one model call, and retries once with a halved keep budget if an overflow still arrives. Configuration reaches the adapter as resolved primitives, never as `NaxConfig`.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome, Zod (config schemas).

**Spec:** `docs/superpowers/specs/2026-09-04-native-context-compaction-design.md` — read it before Task 1. It records why each decision was made and which alternative was rejected.

## Global Constraints

- **Bun-native APIs only.** No Node.js equivalents in `src/`.
- **TypeScript strict. No `any`** in public APIs.
- **`src/agents/native/` must not import `NaxConfig`, `CompleteConfig`, or `DEFAULT_CONFIG`** — settings arrive as resolved primitives on `OpenSessionOpts`. Task 4 makes this a gate.
- **Only `src/agents/native/` may import `@nathapp/nax-ai`** — enforced by `bun run check:nax-ai-imports`. Do not import it from `test/`.
- **File size caps: 600 lines for `src/`, 800 for `test/`** — `bun run check:file-sizes`.
- **Never use bare `bun test` for the full suite.** Full suite is `bun run test`. Targeted iteration is `bun test <path> --timeout=30000`.
- **Never use `as unknown as` in tests, and avoid loose casts** — `check:test-as-unknown-as` pins zero, and `check:test-escape-hatches` ratchets loose casts. Narrow with a type guard or a helper that throws instead.
- **Conventional commits**, one concern per commit.
- **Percentages, not absolute token constants**, for both the threshold and the keep budget. The spec explains why absolute constants break the 7 catalog models with windows at or below 16384.

---

### Task 1: Pure primitives — message type, estimation, threshold, keep budget

**Files:**
- Create: `src/agents/native/session/compaction.ts`
- Modify: `src/agents/native/session/turn-loop.ts:28-42` (move the message type out, import it back)
- Test: `test/unit/agents/native/compaction.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type TranscriptMessage = ConversationMessage | { readonly role: "tool-result"; readonly toolCallId: string; readonly content: string; readonly isError?: boolean; readonly denied?: AdapterInteractionResponse["denied"] }`
  - `interface ResolvedCompaction { enabled: boolean; compactAtPercent: number; keepRecentPercent: number }`
  - `estimateTokens(m: TranscriptMessage): number`
  - `estimateContextTokens(messages: readonly TranscriptMessage[], lastUsage?: { inputTokens: number }, anchorIndex?: number): number`
  - `compactionThreshold(window: number, cfg: ResolvedCompaction): number`
  - `shouldCompact(tokens: number, window: number, cfg: ResolvedCompaction): boolean`
  - `keepBudget(window: number, cfg: ResolvedCompaction, aggressive?: boolean): number`

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/compaction.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  compactionThreshold,
  estimateContextTokens,
  estimateTokens,
  keepBudget,
  shouldCompact,
  type ResolvedCompaction,
  type TranscriptMessage,
} from "@/agents/native/session/compaction";

const cfg: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

describe("estimateTokens", () => {
  test("counts user content as characters over four", () => {
    expect(estimateTokens({ role: "user", content: "a".repeat(400) })).toBe(100);
  });

  test("counts assistant text, thinking and serialized tool arguments", () => {
    const m: TranscriptMessage = {
      role: "assistant",
      content: "ab",
      thinking: [{ text: "cd", signature: "sig" }],
      toolCalls: [{ id: "c1", name: "Read", input: { path: "x" } }],
    };
    // 2 (text) + 2 (thinking) + 4 ("Read") + 14 ('{"path":"x"}' is 12, plus name already counted)
    // Exact total is asserted rather than approximated so a change in what is
    // counted fails loudly instead of drifting.
    expect(estimateTokens(m)).toBe(Math.ceil((2 + 2 + 4 + JSON.stringify({ path: "x" }).length) / 4));
  });

  test("counts tool-result content", () => {
    expect(estimateTokens({ role: "tool-result", toolCallId: "c1", content: "x".repeat(40) })).toBe(10);
  });
});

describe("estimateContextTokens", () => {
  test("anchors on reported usage and estimates only what follows it", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "x".repeat(4000) },
      { role: "assistant", content: "" },
      { role: "user", content: "y".repeat(400) },
    ];
    // Anchor says the first two messages really cost 50 tokens; only the
    // trailing message is guessed. Without the anchor this would read ~1100.
    expect(estimateContextTokens(messages, { inputTokens: 50 }, 1)).toBe(150);
  });

  test("estimates every message when there is no anchor", () => {
    const messages: TranscriptMessage[] = [{ role: "user", content: "x".repeat(400) }];
    expect(estimateContextTokens(messages, undefined, undefined)).toBe(100);
  });
});

describe("compactionThreshold", () => {
  test.each([
    [128_000, 115_200],
    [262_144, 235_929],
    [1_048_576, 943_718],
  ])("uses the configured percentage on a %i window", (window, expected) => {
    expect(compactionThreshold(window, cfg)).toBe(expected);
  });

  test("falls back to the headroom floor when a percentage would leave no room to reply", () => {
    // 4095 is the smallest window in the catalog nax-ai ships. 90% of it leaves
    // 410 tokens, which cannot hold a reply, so the floor takes over at 75%.
    expect(compactionThreshold(4095, cfg)).toBe(3072);
  });

  test("never returns a threshold at or above the window", () => {
    for (const window of [4095, 8192, 128_000, 3_500_000]) {
      expect(compactionThreshold(window, cfg)).toBeLessThan(window);
    }
  });
});

describe("shouldCompact", () => {
  test("fires above the threshold and not at or below it", () => {
    expect(shouldCompact(115_201, 128_000, cfg)).toBe(true);
    expect(shouldCompact(115_200, 128_000, cfg)).toBe(false);
  });

  test("never fires when disabled", () => {
    expect(shouldCompact(999_999, 128_000, { ...cfg, enabled: false })).toBe(false);
  });
});

describe("keepBudget", () => {
  test("is the configured percentage of the window", () => {
    expect(keepBudget(128_000, cfg)).toBe(38_400);
  });

  test("halves for the aggressive backstop", () => {
    expect(keepBudget(128_000, cfg, true)).toBe(19_200);
  });

  test("stays below the threshold, so a compacted transcript cannot re-fire immediately", () => {
    for (const window of [4095, 128_000, 1_048_576]) {
      expect(keepBudget(window, cfg)).toBeLessThan(compactionThreshold(window, cfg));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/compaction.test.ts --timeout=30000`
Expected: FAIL — `Cannot find module '@/agents/native/session/compaction'`

- [ ] **Step 3: Write the module**

Create `src/agents/native/session/compaction.ts`:

```ts
/**
 * Context compaction for the native turn loop.
 *
 * Pure functions only: no file I/O, no model calls, no clock. turn-loop.ts owns
 * the orchestration and the one model call. Keeping this half pure is what makes
 * the cut-point rules testable directly rather than only end to end.
 *
 * See docs/superpowers/specs/2026-09-04-native-context-compaction-design.md.
 */

import type { ConversationMessage } from "@nathapp/nax-ai";
import type { AdapterInteractionResponse } from "@/agents";

/**
 * The transcript message nax stores: nax-ai's ConversationMessage widened with
 * the coding-tool denial marker (ADR-029 s5). The marker is structural data the
 * model must be able to act on — dropping it because the wire type does not
 * know it yet is exactly the defect this widening exists to prevent.
 *
 * Lives here rather than in turn-loop.ts because both modules need it and this
 * is the one without a dependency on the other.
 */
export type TranscriptMessage =
  | ConversationMessage
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
      readonly denied?: AdapterInteractionResponse["denied"];
    };

/** Compaction settings after config resolution. Reaches the adapter as a primitive. */
export interface ResolvedCompaction {
  readonly enabled: boolean;
  readonly compactAtPercent: number;
  readonly keepRecentPercent: number;
}

/** A reply needs room whatever the window is. */
const MIN_HEADROOM_TOKENS = 4096;
/** ...but never take a quarter of a small window for headroom. */
const MAX_HEADROOM_FRACTION = 0.25;
const CHARS_PER_TOKEN = 4;

/**
 * Characters over four. Deliberately crude and deliberately high: over-estimating
 * compacts slightly early, under-estimating overflows.
 */
export function estimateTokens(message: TranscriptMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      chars = message.content.length;
      break;
    case "assistant":
      chars = message.content.length;
      for (const block of message.thinking ?? []) chars += block.text.length;
      for (const call of message.toolCalls ?? []) chars += call.name.length + JSON.stringify(call.input).length;
      break;
    case "tool-result":
      chars = message.content.length;
      break;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Anchor on truth, guess only the tail.
 *
 * `lastUsage.inputTokens` is what the provider actually charged for everything
 * up to and including `anchorIndex`, so only messages after it are estimated.
 * With no anchor every message is estimated, which is the case the reactive
 * backstop exists to cover.
 */
export function estimateContextTokens(
  messages: readonly TranscriptMessage[],
  lastUsage?: { readonly inputTokens: number },
  anchorIndex?: number,
): number {
  if (lastUsage === undefined || anchorIndex === undefined) {
    return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  }
  let trailing = 0;
  for (let i = anchorIndex + 1; i < messages.length; i++) trailing += estimateTokens(messages[i] as TranscriptMessage);
  return lastUsage.inputTokens + trailing;
}

/**
 * The percentage governs; the floor only takes over when a percentage of the
 * window would leave too little room for a reply. Both constants are a safety
 * rail against a window smaller than the defaults assume, not tuning knobs —
 * which is why they are not config.
 */
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/compaction.test.ts --timeout=30000`
Expected: PASS, all tests.

- [ ] **Step 5: Point turn-loop at the shared type**

In `src/agents/native/session/turn-loop.ts`, delete the local `NativeTranscriptMessage` type declaration (and its doc comment, which moved to `compaction.ts`) and import the shared one, keeping the old name as a local alias so no other line in the file changes:

```ts
import { type TranscriptMessage as NativeTranscriptMessage } from "./compaction";
```

- [ ] **Step 6: Verify nothing else broke**

Run: `bun run typecheck`
Expected: clean.
Run: `bun test test/unit/agents/native/ --timeout=30000`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/session/compaction.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/compaction.test.ts
git commit -m "feat: add pure compaction primitives for the native turn loop"
```

---

### Task 2: Pure primitives — cut point, preparation, and array rewriting

**Files:**
- Modify: `src/agents/native/session/compaction.ts`
- Test: `test/unit/agents/native/compaction.test.ts`

**Interfaces:**
- Consumes: `TranscriptMessage`, `estimateTokens`, `keepBudget` from Task 1.
- Produces:
  - `const COMPACTION_SUMMARY_PREFIX: string`
  - `const COMPACTION_SUMMARY_SUFFIX: string`
  - `findCutPoint(messages: readonly TranscriptMessage[], startIndex: number, keepTokens: number): number`
  - `interface CompactionPlan { cutIndex: number; toSummarize: readonly TranscriptMessage[]; previousSummary?: string }`
  - `prepareCompaction(messages: readonly TranscriptMessage[], keepTokens: number): CompactionPlan | undefined`
  - `applyCompaction(messages: readonly TranscriptMessage[], plan: CompactionPlan, summary: string): TranscriptMessage[]`

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/compaction.test.ts`:

```ts
import {
  applyCompaction,
  COMPACTION_SUMMARY_PREFIX,
  findCutPoint,
  prepareCompaction,
} from "@/agents/native/session/compaction";

/** A user/assistant/tool-result triple of a known size, for building transcripts. */
function exchange(id: string, size: number): TranscriptMessage[] {
  return [
    { role: "assistant", content: "a".repeat(size), toolCalls: [{ id, name: "Read", input: { path: id } }] },
    { role: "tool-result", toolCallId: id, content: "r".repeat(size) },
  ];
}

describe("findCutPoint", () => {
  test("never cuts at a tool-result, because that orphans it from its tool call", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      ...exchange("c1", 4000),
      ...exchange("c2", 4000),
    ];
    // A budget that lands mid-exchange would naively cut at the tool-result.
    const cut = findCutPoint(messages, 1, 1000);
    expect(messages[cut].role).not.toBe("tool-result");
  });

  test("refuses every cut that would orphan a result, across every budget", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      ...exchange("c1", 400),
      ...exchange("c2", 400),
      ...exchange("c3", 400),
    ];
    for (let budget = 1; budget < 2000; budget += 37) {
      expect(messages[findCutPoint(messages, 1, budget)].role).not.toBe("tool-result");
    }
  });

  test("keeps an assistant message whole, so a thinking block keeps its signature", () => {
    // ADR-028 s8: Anthropic requires the exact thinking block, text plus
    // signature, replayed on the next turn. Cutting inside an assistant message
    // is the only way to break that, so the cut index must always name a
    // message boundary.
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "x".repeat(4000), thinking: [{ text: "why", signature: "sig-1" }] },
      { role: "user", content: "next" },
    ];
    const cut = findCutPoint(messages, 1, 100);
    expect(Number.isInteger(cut)).toBe(true);
    const kept = messages.slice(cut);
    for (const m of kept) {
      if (m.role === "assistant" && m.thinking) expect(m.thinking[0].signature).toBe("sig-1");
    }
  });
});

/**
 * Four small exchanges with a keep budget of 250 tokens. Sizes are chosen so a
 * cut genuinely lands mid-transcript: with two 1000-token exchanges and a
 * 1000-token budget the walk reaches its budget on the very first message it
 * visits, `findCutPoint` returns the earliest valid cut, and prepareCompaction
 * correctly reports "nothing to do" — which would make every assertion below
 * vacuous.
 */
const KEEP = 250;
const fourExchanges: TranscriptMessage[] = [
  { role: "user", content: "the task" },
  ...exchange("c1", 400),
  ...exchange("c2", 400),
  ...exchange("c3", 400),
  ...exchange("c4", 400),
];

describe("prepareCompaction", () => {
  test("returns undefined when there is nothing between the pin and the cut", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "short" },
    ];
    expect(prepareCompaction(messages, 100_000)).toBeUndefined();
  });

  test("never includes the pinned first message in the span to summarize", () => {
    const plan = prepareCompaction(fourExchanges, KEEP);
    expect(plan).toBeDefined();
    expect(plan?.toSummarize).not.toContain(fourExchanges[0]);
  });
});

describe("applyCompaction", () => {
  const messages = fourExchanges;

  test("leaves the pinned message byte-identical, so its cache prefix survives", () => {
    const plan = prepareCompaction(messages, KEEP);
    if (!plan) throw new Error("expected a plan");
    const out = applyCompaction(messages, plan, "what happened");
    expect(out[0]).toEqual(messages[0]);
  });

  test("places the summary immediately after the pin, carrying the prefix", () => {
    const plan = prepareCompaction(messages, KEEP);
    if (!plan) throw new Error("expected a plan");
    const out = applyCompaction(messages, plan, "what happened");
    expect(out[1].role).toBe("user");
    expect(out[1].role === "user" && out[1].content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(out[1].role === "user" && out[1].content.includes("what happened")).toBe(true);
  });

  test("shrinks the transcript", () => {
    const plan = prepareCompaction(messages, KEEP);
    if (!plan) throw new Error("expected a plan");
    expect(applyCompaction(messages, plan, "s").length).toBeLessThan(messages.length);
  });

  test("replaces the previous summary rather than stacking a second one", () => {
    const first = prepareCompaction(messages, KEEP);
    if (!first) throw new Error("expected a plan");
    const already = applyCompaction(messages, first, "first summary");
    const grown: TranscriptMessage[] = [...already, ...exchange("c5", 400), ...exchange("c6", 400)];
    const plan = prepareCompaction(grown, 1000);
    if (!plan) throw new Error("expected a plan");
    expect(plan.previousSummary).toBe("first summary");

    const out = applyCompaction(grown, plan, "merged summary");
    const summaries = out.filter((m) => m.role === "user" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].role === "user" && summaries[0].content.includes("merged summary")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/compaction.test.ts --timeout=30000`
Expected: FAIL — `findCutPoint` / `prepareCompaction` / `applyCompaction` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/agents/native/session/compaction.ts`:

```ts
/**
 * Marks the summary message. The summary carries no marker FIELD: transcript
 * messages reach nax-ai structurally, so an extra property would travel to the
 * wire (the existing `denied` marker already does). Position plus this prefix
 * is how a later compaction finds the summary it must replace.
 */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>\n";

/** Index of the pinned first message; never summarized, never dropped. */
const PIN_INDEX = 0;
/** Where the summary sits once written. */
const SUMMARY_INDEX = 1;

/**
 * Valid cut points are user or assistant messages, NEVER a tool-result.
 *
 * That one rule carries both hard constraints: a tool-result can never become
 * the first kept message (orphaning it from its tool_use, which the provider
 * rejects), and cuts land between messages rather than inside an assistant
 * message, so a kept thinking block keeps its exact text and signature.
 */
function isValidCut(message: TranscriptMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

/**
 * Walk backwards accumulating estimated size; once `keepTokens` is reached, take
 * the nearest valid cut at or after that point.
 *
 * Two passes on purpose. A single backwards pass that remembers the last valid
 * index it saw returns `messages.length` whenever trailing tool-results consume
 * the whole budget before any valid cut appears — an out-of-range index the
 * caller then dereferences. Collecting the valid cuts first makes "the nearest
 * cut at or after i" answerable without that hole, and `cuts[0]` is the honest
 * default: keep everything, which `prepareCompaction` reads as "no plan".
 */
export function findCutPoint(
  messages: readonly TranscriptMessage[],
  startIndex: number,
  keepTokens: number,
): number {
  const cuts: number[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    if (isValidCut(messages[i] as TranscriptMessage)) cuts.push(i);
  }
  if (cuts.length === 0) return messages.length;

  let candidate = cuts[0] as number;
  let accumulated = 0;
  for (let i = messages.length - 1; i >= startIndex; i--) {
    accumulated += estimateTokens(messages[i] as TranscriptMessage);
    if (accumulated >= keepTokens) {
      const at = cuts.find((c) => c >= i);
      if (at !== undefined) candidate = at;
      break;
    }
  }
  return candidate;
}

export interface CompactionPlan {
  readonly cutIndex: number;
  readonly toSummarize: readonly TranscriptMessage[];
  readonly previousSummary?: string;
}

/** Reads a previous summary out of the message at SUMMARY_INDEX, if one is there. */
function readPreviousSummary(messages: readonly TranscriptMessage[]): string | undefined {
  const candidate = messages[SUMMARY_INDEX];
  if (candidate === undefined || candidate.role !== "user") return undefined;
  if (!candidate.content.startsWith(COMPACTION_SUMMARY_PREFIX)) return undefined;
  return candidate.content.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
}

export function prepareCompaction(
  messages: readonly TranscriptMessage[],
  keepTokens: number,
): CompactionPlan | undefined {
  const previousSummary = readPreviousSummary(messages);
  // Everything from here is fair game; the pin, and any existing summary, are not.
  const spanStart = previousSummary === undefined ? PIN_INDEX + 1 : SUMMARY_INDEX + 1;
  const cutIndex = findCutPoint(messages, spanStart, keepTokens);
  if (cutIndex <= spanStart) return undefined;
  return {
    cutIndex,
    toSummarize: messages.slice(spanStart, cutIndex),
    ...(previousSummary !== undefined ? { previousSummary } : {}),
  };
}

export function applyCompaction(
  messages: readonly TranscriptMessage[],
  plan: CompactionPlan,
  summary: string,
): TranscriptMessage[] {
  return [
    messages[PIN_INDEX] as TranscriptMessage,
    { role: "user", content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX },
    ...messages.slice(plan.cutIndex),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/compaction.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Prove the tool-result rule is load-bearing**

Temporarily change `isValidCut` to `return message.role !== "__never__";` (accepting every role), re-run the test file, and confirm the two tool-result tests FAIL. Then revert.

This is the reintroduce-the-bug check: a rule with a test that passes either way is not a gate.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/compaction.ts test/unit/agents/native/compaction.test.ts
git commit -m "feat: add cut-point and rewrite primitives for compaction"
```

---

### Task 3: Config surface and the resolved-primitive path to the adapter

**Files:**
- Modify: `src/config/schemas-execution.ts:198-220` (inside `ExecutionConfigSchema`)
- Modify: `src/config/runtime-types.ts:105-115`
- Modify: `src/agents/session-types.ts:47-75` (`OpenSessionOpts`)
- Modify: `src/agents/native/session/session.ts`
- Test: `test/unit/config/execution-compaction.test.ts`
- Test: `test/unit/agents/native/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `ResolvedCompaction` from Task 1.
- Produces:
  - `ExecutionConfig.compaction: { enabled: boolean; compactAtPercent: number; keepRecentPercent: number }`
  - `OpenSessionOpts.compaction?: ResolvedCompaction`
  - `nativeSessionCompaction: Map<string, ResolvedCompaction>` exported from `session/session.ts`
  - `nativeSessionLastUsage: Map<string, { inputTokens: number; anchorIndex: number }>` exported from `session/session.ts`

- [ ] **Step 1: Write the failing config test**

Create `test/unit/config/execution-compaction.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

/** The rest of ExecutionConfig's required fields, so only compaction is under test. */
const base = {
  maxIterations: 3,
  iterationDelayMs: 0,
  costLimit: 10,
  maxStoriesPerFeature: 10,
  rectification: {},
  regressionGate: {},
  smartTestRunner: {},
};

describe("execution.compaction", () => {
  test("defaults to enabled at 90% with 30% kept", () => {
    const parsed = ExecutionConfigSchema.parse(base);
    expect(parsed.compaction).toEqual({ enabled: true, compactAtPercent: 90, keepRecentPercent: 30 });
  });

  test("rejects a keep percentage that is not well below the trigger", () => {
    // 60 and 50 are both inside their own field ranges, but a transcript
    // compacted to 60% of the window still sits above a 50% trigger and would
    // re-fire every round trip. The cross-field check is what catches it.
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 50, keepRecentPercent: 60 },
    });
    expect(result.success).toBe(false);
  });

  test("accepts a keep percentage exactly 20 points below the trigger", () => {
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 70 },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a trigger above 99, which would leave no headroom", () => {
    const result = ExecutionConfigSchema.safeParse({
      ...base,
      compaction: { enabled: true, compactAtPercent: 100, keepRecentPercent: 30 },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/config/execution-compaction.test.ts --timeout=30000`
Expected: FAIL — `parsed.compaction` is `undefined`.

- [ ] **Step 3: Add the schema**

In `src/config/schemas-execution.ts`, inside `ExecutionConfigSchema`, after `contextProviderTokenBudget`:

```ts
  /**
   * Native context compaction. Percentages of the model's window rather than
   * absolute token counts: nax-ai's catalog spans 4095 to 3.5M tokens, and an
   * absolute reserve is negative on the smallest windows — compaction would
   * fire every round trip and shrink nothing.
   */
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

In `src/config/runtime-types.ts`, alongside `sessionErrorMaxRetries`:

```ts
  compaction: {
    enabled: boolean;
    compactAtPercent: number;
    keepRecentPercent: number;
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/config/execution-compaction.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Write the failing session-plumbing test**

Append to `test/unit/agents/native/session-lifecycle.test.ts`:

```ts
import { nativeSessionCompaction, nativeSessionLastUsage } from "@/agents/native/session/session";

describe("native session compaction settings", () => {
  const settings = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

  test("openSession records the resolved settings for the turn to read", async () => {
    const handle = await openNativeSession("sess-cfg", opts({ compaction: settings }));
    expect(nativeSessionCompaction.get("sess-cfg")).toEqual(settings);
    await closeNativeSession(handle, false);
  });

  test("closing clears the settings and the usage anchor, like every other session map", async () => {
    const handle = await openNativeSession("sess-cfg2", opts({ compaction: settings }));
    nativeSessionLastUsage.set("sess-cfg2", { inputTokens: 10, anchorIndex: 0 });
    await closeNativeSession(handle, false);
    expect(nativeSessionCompaction.has("sess-cfg2")).toBe(false);
    expect(nativeSessionLastUsage.has("sess-cfg2")).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/unit/agents/native/session-lifecycle.test.ts --timeout=30000`
Expected: FAIL — no export named `nativeSessionCompaction`.

- [ ] **Step 7: Add the option and the maps**

In `src/agents/session-types.ts`, add to `OpenSessionOpts`:

```ts
  /**
   * Native: resolved compaction settings. A resolved primitive, never NaxConfig —
   * src/agents/native/ must not read config (check:adapter-no-config-import).
   */
  compaction?: import("./native/session/compaction").ResolvedCompaction;
```

In `src/agents/native/session/session.ts`, beside the existing maps:

```ts
/** Session name -> resolved compaction settings. Same lifecycle as the maps above. */
export const nativeSessionCompaction = new Map<string, ResolvedCompaction>();

/**
 * Session name -> the last round trip's reported input tokens and the index it
 * covers, so the next estimate can anchor on a real number.
 *
 * In-memory rather than persisted because runNativeTurn reloads the transcript
 * from disk on EVERY turn: without this the second turn of every session would
 * be estimated from scratch. A process restart still loses it, which is the case
 * the reactive backstop covers.
 */
export const nativeSessionLastUsage = new Map<string, { inputTokens: number; anchorIndex: number }>();
```

In `openNativeSession`, after `nativeSessionTimeouts.set(...)`:

```ts
  if (opts.compaction !== undefined) nativeSessionCompaction.set(name, opts.compaction);
```

In `closeNativeSession`, beside the other deletes:

```ts
  nativeSessionCompaction.delete(handle.id);
  nativeSessionLastUsage.delete(handle.id);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test test/unit/agents/native/ test/unit/config/execution-compaction.test.ts --timeout=30000`
Expected: PASS.
Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/config/schemas-execution.ts src/config/runtime-types.ts src/agents/session-types.ts src/agents/native/session/session.ts test/unit/config/execution-compaction.test.ts test/unit/agents/native/session-lifecycle.test.ts
git commit -m "feat: add execution.compaction config and its resolved path to the native session"
```

---

### Task 4: Gate the no-config rule for `src/agents/native/`

**Files:**
- Modify: `scripts/check-adapter-no-config-import.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a gate that fails if `src/agents/native/` imports `NaxConfig`, `CompleteConfig`, or `DEFAULT_CONFIG`.

Task 3 relies on native never reading config. Today that is enforced for `src/agents/acp/` only, so nothing stops a future edit importing `NaxConfig` here. A prose boundary rule without a gate is a comment.

- [ ] **Step 1: Prove the gate does not currently cover native**

```bash
printf 'import type { NaxConfig } from "@/config";\nexport const x: NaxConfig | undefined = undefined;\n' > src/agents/native/__gate_probe.ts
bash scripts/check-adapter-no-config-import.sh; echo "exit=$?"
```

Expected: `exit=0` — the gate passes, which is the defect.

- [ ] **Step 2: Extend the gate to both directories**

In `scripts/check-adapter-no-config-import.sh`, replace each `src/agents/acp/` scan target with both directories. The three `grep -r` invocations become:

```bash
scan_dirs="src/agents/acp/ src/agents/native/"

banned_imports=$(grep -r "import.*\(NaxConfig\|CompleteConfig\|DEFAULT_CONFIG\)" $scan_dirs --include="*.ts" 2>/dev/null || true)
defaults_loader=$(grep -r "import.*config/\(defaults\|loader\)" $scan_dirs --include="*.ts" 2>/dev/null || true)
options_config=$(grep -r "options\?\?\.config\b\|_options\.config\b\|options\.config\b" $scan_dirs --include="*.ts" 2>/dev/null || true)
```

Update the error message so it names the directory that failed rather than saying "ACP adapter".

- [ ] **Step 3: Run the gate to verify it now fails**

```bash
bash scripts/check-adapter-no-config-import.sh; echo "exit=$?"
```

Expected: `exit=1`, naming `src/agents/native/__gate_probe.ts`.

- [ ] **Step 4: Remove the probe and confirm green**

```bash
rm src/agents/native/__gate_probe.ts
bash scripts/check-adapter-no-config-import.sh; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-adapter-no-config-import.sh
git commit -m "chore: extend the adapter no-config gate to src/agents/native/"
```

---

### Task 5: Turn-loop wiring — proactive compaction

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts`
- Test: `test/unit/agents/native/turn-loop-compaction.test.ts`

A new test file rather than growing `turn-loop.test.ts`, which is 577 lines against an 800-line cap.

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces:
  - `TurnDeps.summarize(messages: readonly TranscriptMessage[], previousSummary?: string): Promise<NativeSummaryResponse>`
  - `interface NativeSummaryResponse { text: string; usage: TokenUsage; costUsd: number }`
  - `TurnDeps.contextWindow?: number`
  - `TurnDeps.compaction?: ResolvedCompaction`

- [ ] **Step 1: Write the failing test**

Create `test/unit/agents/native/turn-loop-compaction.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACTION_SUMMARY_PREFIX, type ResolvedCompaction } from "@/agents/native/session/compaction";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { SendTurnOpts } from "@/agents/session-types";

let dir: string;
const handle = { id: "sess-c", agentName: "native" } as const;
const cfg: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };
const usage = { inputTokens: 1, outputTokens: 1 };
const opts = (): SendTurnOpts => ({ interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-compact-"));
  nativeTranscriptDirs.set("sess-c", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-c");
  await rm(dir, { recursive: true, force: true });
});

/** A transcript already far past a small window. */
async function seedOversizedTranscript() {
  await saveTranscript(dir, "sess-c", [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(20_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(20_000) },
  ]);
}

describe("proactive compaction", () => {
  test("compacts before the call when the estimate crosses the threshold", async () => {
    await seedOversizedTranscript();
    let sentToModel: readonly { role: string }[] = [];
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "did some work", usage, costUsd: 0.01 };
      },
      complete: async (messages) => {
        sentToModel = messages;
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(summarizeCalls).toBe(1);
    expect(sentToModel[1].role).toBe("user");
    const second = sentToModel[1] as { role: "user"; content: string };
    expect(second.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(second.content).toContain("did some work");
  });

  test("does not compact when the conversation fits", async () => {
    await saveTranscript(dir, "sess-c", [{ role: "user", content: "small" }]);
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 200_000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "unused", usage, costUsd: 0 };
      },
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    expect(summarizeCalls).toBe(0);
  });

  test("never compacts when no context window is known", async () => {
    await seedOversizedTranscript();
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "unused", usage, costUsd: 0 };
      },
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    expect(summarizeCalls).toBe(0);
  });

  test("a failed summary leaves the conversation untouched and does not fail the turn", async () => {
    await seedOversizedTranscript();
    let sentToModel: readonly unknown[] = [];

    const result = await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        throw new Error("summarizer unavailable");
      },
      complete: async (messages) => {
        sentToModel = messages;
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(result.output).toBe("done");
    expect(sentToModel).toHaveLength(5); // 4 seeded + the new prompt, nothing dropped
  });

  test("counts the summary's cost but not as a round trip", async () => {
    await seedOversizedTranscript();

    const result = await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => ({ text: "summary", usage: { inputTokens: 500, outputTokens: 50 }, costUsd: 0.25 }),
      complete: async () => ({ text: "done", usage, costUsd: 0.5 }),
    });

    expect(result.estimatedCostUsd).toBeCloseTo(0.75, 6);
    expect(result.internalRoundTrips).toBe(1);
    expect(result.tokenUsage.inputTokens).toBe(501);
  });

  test("emits a usage activity for the summary, so the idle watchdog sees it", async () => {
    await seedOversizedTranscript();
    const activity: string[] = [];

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      onActivity: (a) => activity.push(a.kind),
      summarize: async () => ({ text: "summary", usage, costUsd: 0.01 }),
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    // Two usage events: the summary's and the round trip's.
    expect(activity.filter((k) => k === "usage")).toHaveLength(2);
  });

  test("persists the compacted conversation", async () => {
    await seedOversizedTranscript();

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    const saved = await loadTranscript(dir, "sess-c");
    expect(saved[0]).toEqual({ role: "user", content: "the task" });
    expect(saved[1].role === "user" && saved[1].content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  });

  test("compacts once per round trip even when the result is still over the threshold", async () => {
    await seedOversizedTranscript();
    let summarizeCalls = 0;

    await runNativeTurn(handle, "next", opts(), {
      contextWindow: 8000,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        // A summary so large the transcript is STILL over the threshold after
        // compacting. Without the once-per-round-trip bound this is the input
        // that would compact repeatedly.
        return { text: "s".repeat(40_000), usage, costUsd: 0 };
      },
      complete: async () => ({ text: "done", usage, costUsd: 0 }),
    });

    expect(summarizeCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop-compaction.test.ts --timeout=30000`
Expected: FAIL — `TurnDeps` has no `summarize`, typecheck errors on the deps object.

- [ ] **Step 3: Extend TurnDeps**

In `src/agents/native/session/turn-loop.ts`, add to `TurnDeps` and import what it needs.

The usage anchor lives on the existing `./session` import, which currently brings in
`nativeTranscriptDirs` only — extend it:

```ts
import { nativeSessionLastUsage, nativeTranscriptDirs } from "./session";
```

```ts
import {
  applyCompaction,
  estimateContextTokens,
  keepBudget,
  prepareCompaction,
  shouldCompact,
  type ResolvedCompaction,
  type TranscriptMessage as NativeTranscriptMessage,
} from "./compaction";

/** What one summarization call returns. Usage and cost are surfaced, not swallowed. */
export interface NativeSummaryResponse {
  readonly text: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}
```

```ts
export interface TurnDeps {
  complete(messages, tools): Promise<NativeTurnResponse>;
  /**
   * One model call, no tools, used only to summarize a dropped span. Separate
   * from complete() because it must not advertise tools, must not count as a
   * round trip, and its cost must be attributable.
   */
  summarize?(
    messages: readonly NativeTranscriptMessage[],
    previousSummary?: string,
  ): Promise<NativeSummaryResponse>;
  /** ResolvedModel.contextWindow. Absent disables compaction. */
  contextWindow?: number;
  /** Resolved settings. Absent disables compaction. */
  compaction?: ResolvedCompaction;
  deadline?: TurnDeadline;
  onActivity?: (activity: NativeTurnActivity) => void;
}
```

- [ ] **Step 4: Add the compaction step to the loop**

Inside `runNativeTurn`, before the `while (true)` loop:

```ts
  const anchor = nativeSessionLastUsage.get(handle.id);
  let lastUsage = anchor?.inputTokens !== undefined ? { inputTokens: anchor.inputTokens } : undefined;
  let anchorIndex = anchor?.anchorIndex;
```

Inside the loop, immediately after the deadline check and before `deps.complete`:

```ts
    // Compaction runs at most once per round trip. That bound is what stops a
    // compact-still-over-compact loop when the pinned prompt alone is too large.
    let summarizeFailed = false;
    if (
      deps.summarize !== undefined &&
      deps.contextWindow !== undefined &&
      deps.compaction !== undefined &&
      shouldCompact(estimateContextTokens(messages, lastUsage, anchorIndex), deps.contextWindow, deps.compaction)
    ) {
      const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction));
      if (plan !== undefined) {
        try {
          const summary = await deps.summarize(plan.toSummarize, plan.previousSummary);
          // Rebound, not spliced in place: `messages` is a local accumulator and
          // rebinding it keeps the compacted array a fresh value. This requires
          // changing its declaration near the top of runNativeTurn from
          // `const messages: NativeTranscriptMessage[] = [...]` to `let messages`.
          messages = applyCompaction(messages, plan, summary.text);
          inputTokens += summary.usage.inputTokens;
          outputTokens += summary.usage.outputTokens;
          costUsd += summary.costUsd;
          // Resets the watchdog's lastActivityAt between the summary and the
          // round trip, so the two silent spans do not add up against one budget.
          deps.onActivity?.({
            kind: "usage",
            inputTokens: summary.usage.inputTokens,
            outputTokens: summary.usage.outputTokens,
            costUsd: summary.costUsd,
          });
          // The anchor described the pre-compaction array; it is meaningless now.
          lastUsage = undefined;
          anchorIndex = undefined;
        } catch (err) {
          // Not fatal: the request may still fit, and if it does not it fails
          // through the path #1837 and #1839 made correct. Killing a story
          // because a summarizer hiccuped would be worse than the problem.
          summarizeFailed = true;
          getSafeLogger()?.warn("native-adapter", "compaction summary failed; sending uncompacted", {
            sessionName: handle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
```

After the `deps.complete` call returns and usage is accumulated, refresh the anchor:

```ts
    lastUsage = { inputTokens: res.usage.inputTokens };
    anchorIndex = messages.length - 1;
    nativeSessionLastUsage.set(handle.id, { inputTokens: res.usage.inputTokens, anchorIndex });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop-compaction.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 6: Verify nothing regressed**

Run: `bun test test/unit/agents/native/ --timeout=30000`
Expected: PASS.
Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop-compaction.test.ts
git commit -m "feat: compact the native transcript before it crosses the context window"
```

---

### Task 6: Reactive backstop

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts`
- Test: `test/unit/agents/native/turn-loop-compaction.test.ts`

**Interfaces:**
- Consumes: Task 5's compaction step.
- Produces: no new exported surface — behaviour only.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/turn-loop-compaction.test.ts`:

```ts
class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

/**
 * A transcript that fits under the proactive threshold but is still large enough
 * for the aggressive keep budget to find a cut.
 *
 * The sizing is load-bearing and was derived, not guessed. At a 20000-token
 * window the threshold is 15904 (90% capped by headroom) and the aggressive keep
 * budget is 3000; this transcript is ~8006 tokens, so the proactive check stays
 * silent and only the backstop can compact. A large window does NOT work here:
 * at 1_000_000 the aggressive budget is 150_000 tokens, more than the whole
 * transcript, so prepareCompaction returns undefined and the backstop rethrows.
 */
const BACKSTOP_WINDOW = 20_000;
async function seedModerateTranscript() {
  await saveTranscript(dir, "sess-c", [
    { role: "user", content: "the task" },
    { role: "assistant", content: "a".repeat(16_000) },
    { role: "user", content: "keep going" },
    { role: "assistant", content: "b".repeat(16_000) },
  ]);
}

describe("reactive backstop", () => {
  test("compacts and retries once when an overflow gets through", async () => {
    await seedModerateTranscript();
    let completes = 0;
    let summarizeCalls = 0;

    const result = await runNativeTurn(handle, "next", opts(), {
      contextWindow: BACKSTOP_WINDOW,
      compaction: cfg,
      summarize: async () => {
        summarizeCalls += 1;
        return { text: "summary", usage, costUsd: 0 };
      },
      complete: async () => {
        completes += 1;
        if (completes === 1) {
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        }
        return { text: "done", usage, costUsd: 0 };
      },
    });

    expect(summarizeCalls).toBe(1);
    expect(completes).toBe(2);
    expect(result.output).toBe("done");
  });

  test("retries once, not repeatedly", async () => {
    await seedModerateTranscript();
    let completes = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: BACKSTOP_WINDOW,
        compaction: cfg,
        summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");

    expect(completes).toBe(2);
  });

  test("does not retry an overflow when the summarizer already failed this round trip", async () => {
    await seedOversizedTranscript();
    let completes = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: 8000, // proactive fires first, and fails
        compaction: cfg,
        summarize: async () => {
          throw new Error("summarizer unavailable");
        },
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "context-overflow", message: "prompt is too long" });
        },
      }),
    ).rejects.toThrow("prompt is too long");

    // One attempt only: paying twice to fail the same way helps nobody.
    expect(completes).toBe(1);
  });

  test("leaves a non-overflow protocol error alone", async () => {
    await seedModerateTranscript();
    let completes = 0;

    await expect(
      runNativeTurn(handle, "next", opts(), {
        contextWindow: BACKSTOP_WINDOW,
        compaction: cfg,
        summarize: async () => ({ text: "summary", usage, costUsd: 0 }),
        complete: async () => {
          completes += 1;
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429" });
        },
      }),
    ).rejects.toThrow("429");

    expect(completes).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/turn-loop-compaction.test.ts --timeout=30000`
Expected: FAIL — the first overflow propagates; `completes` is 1, not 2.

- [ ] **Step 3: Implement the backstop**

In `src/agents/native/session/turn-loop.ts`, add the guard near `isValidCut`'s neighbours at module scope:

```ts
/**
 * Structural, matching adapter.ts's guard: nax-ai's error class is not importable
 * here and the kind is what matters.
 */
function isContextOverflow(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("protocolError" in err)) return false;
  const { protocolError } = err as { protocolError?: { kind?: unknown } };
  return protocolError?.kind === "context-overflow";
}
```

Replace the bare `const res = await deps.complete(messages, tools);` with:

```ts
    let res: NativeTurnResponse;
    try {
      res = await deps.complete(messages, tools);
    } catch (err) {
      const canRetry =
        isContextOverflow(err) &&
        !summarizeFailed &&
        deps.summarize !== undefined &&
        deps.contextWindow !== undefined &&
        deps.compaction !== undefined;
      if (!canRetry) throw err;

      // Same code path, half the keep budget. Not a second algorithm.
      const plan = prepareCompaction(messages, keepBudget(deps.contextWindow, deps.compaction, true));
      if (plan === undefined) throw err;
      const summary = await deps.summarize(plan.toSummarize, plan.previousSummary);
      messages = applyCompaction(messages, plan, summary.text);
      inputTokens += summary.usage.inputTokens;
      outputTokens += summary.usage.outputTokens;
      costUsd += summary.costUsd;
      deps.onActivity?.({
        kind: "usage",
        inputTokens: summary.usage.inputTokens,
        outputTokens: summary.usage.outputTokens,
        costUsd: summary.costUsd,
      });
      lastUsage = undefined;
      anchorIndex = undefined;
      // Retried once. A second overflow propagates: compacting further would be
      // guessing, and the failure now carries a correct diagnosis.
      res = await deps.complete(messages, tools);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/turn-loop-compaction.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: all phases pass.
Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/turn-loop.ts test/unit/agents/native/turn-loop-compaction.test.ts
git commit -m "feat: retry once with a harder compaction when an overflow gets through"
```

---

### Task 7: Adapter wiring

**Files:**
- Modify: `src/agents/native/adapter.ts` (the `sendTurn` deps object)
- Test: `test/unit/agents/native/adapter.test.ts`

**Interfaces:**
- Consumes: `TurnDeps.summarize` / `contextWindow` / `compaction` from Task 5, `nativeSessionCompaction` from Task 3.
- Produces: nothing new; this is the last wire.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/agents/native/adapter.test.ts`:

```ts
describe("NativeAgentAdapter compaction wiring", () => {
  /** Small enough that a seeded transcript is already over the threshold. */
  const SMALL_MODEL = { ...MODEL, contextWindow: 8000 } satisfies ResolvedModel;
  const settings = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

  async function openWithSeededTranscript(name: string, client: Client) {
    _clientDeps.build = async () => client;
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), `nax-adapter-${name}-`));
    const handle = await adapter.openSession(name, {
      agentName: "native",
      workdir: process.cwd(),
      resolvedPermissions: { mode: "approve-all" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
      compaction: settings,
    });
    await saveTranscript(transcriptDir, name, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(20_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(20_000) },
    ]);
    return { adapter, handle, transcriptDir };
  }

  test("passes the model's real context window through, so compaction fires on a small one", async () => {
    // Behavioural rather than a spy: the only way a summarize call happens here
    // is if SMALL_MODEL.contextWindow (8000) reached the turn loop. A hardcoded
    // constant, or a dropped wire, produces zero summarize calls.
    let completeCalls = 0;
    const client = fakeClient({
      model: async () => SMALL_MODEL,
      complete: async () => {
        completeCalls += 1;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      },
    });
    const { adapter, handle } = await openWithSeededTranscript("sess-compact-wire", client);

    await adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

    // One summarize plus one round trip.
    expect(completeCalls).toBe(2);
  });

  test("the summary call advertises no tools", async () => {
    const requests: ClientRequest[] = [];
    const client = fakeClient({
      model: async () => SMALL_MODEL,
      complete: async (_m: ResolvedModel, req: ClientRequest) => {
        requests.push(req);
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      },
    });
    const { adapter, handle } = await openWithSeededTranscript("sess-sum", client);

    await adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

    // requests[0] is the summary, requests[1] the round trip.
    expect(requests[0].tools).toBeUndefined();
  });

  test("never compacts when the window is large", async () => {
    let completeCalls = 0;
    const client = fakeClient({
      complete: async () => {
        completeCalls += 1;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      },
    });
    // MODEL.contextWindow is 128_000; the same seeded transcript fits.
    const { adapter, handle } = await openWithSeededTranscript("sess-nocompact", client);

    await adapter.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });

    expect(completeCalls).toBe(1);
  });
});
```

Add `saveTranscript` to the file's imports:

```ts
import { loadTranscript, saveTranscript } from "@/agents/native/session/transcript-store";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/agents/native/adapter.test.ts --timeout=30000`
Expected: FAIL — `compaction` is not accepted on `openSession` opts, or `summarize` is never supplied.

- [ ] **Step 3: Wire the adapter**

In `src/agents/native/adapter.ts`, import the settings map and add the three deps to the `runNativeTurn` call:

```ts
import { nativeSessionCompaction } from "./session/session";
```

```ts
      result = await runNativeTurn(handle, prompt, opts, {
        deadline,
        contextWindow: resolved.contextWindow,
        ...(nativeSessionCompaction.get(handle.id) !== undefined
          ? { compaction: nativeSessionCompaction.get(handle.id) }
          : {}),
        onActivity: (activity) => {
          hooks?.onStreamActivity?.(buildNativeStreamEvent(eventBase, activity, Date.now()));
        },
        summarize: async (span, previousSummary) => {
          // Same model, same clock, no tools. The prompt asks for what a coding
          // agent needs back: what was tried, what was rejected and why, and the
          // files touched -- without them the agent re-reads what it already read.
          const remainingMs = deadline.remainingMs();
          const controller = new AbortController();
          const timer = remainingMs !== undefined ? setTimeout(() => controller.abort(), remainingMs) : undefined;
          const signal = AbortSignal.any(
            opts.signal !== undefined
              ? [opts.signal, controller.signal, turnController.signal]
              : [controller.signal, turnController.signal],
          );
          try {
            const res = await client.complete(resolved, {
              messages: [...span, { role: "user", content: summaryPrompt(previousSummary) }],
              sessionId,
              signal,
            });
            const summaryUsage = toNaxTokenUsage(res.usage);
            return { text: res.text, usage: summaryUsage, costUsd: estimateCostUsd(summaryUsage, rates) };
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
        complete: async (messages, tools) => {
          /* unchanged */
        },
      });
```

Add the prompt builder at module scope in `adapter.ts`:

```ts
function summaryPrompt(previousSummary?: string): string {
  const base =
    "Summarize the conversation above so it can be dropped from context. " +
    "Record what was attempted, what was rejected and why, any decisions that still bind, " +
    "and list the files read and the files modified. Be specific: this summary is the only " +
    "memory of this work that survives.";
  if (previousSummary === undefined) return base;
  return (
    `${base}\n\nAn earlier summary of still-older history follows. Merge it into your summary ` +
    `rather than repeating or discarding it:\n\n${previousSummary}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/agents/native/adapter.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Check the file-size gate**

Run: `bun run check:file-sizes`
Expected: OK. `adapter.ts` was 323 lines; if this pushes it near 600, extract `summarize` into `src/agents/native/session/summarize.ts` and import it.

- [ ] **Step 6: Full verification**

Run: `bun run test`
Expected: all phases pass.
Run: `bun run typecheck && bun run lint`
Expected: clean, all 24 gates.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/adapter.ts test/unit/agents/native/adapter.test.ts
git commit -m "feat: wire compaction into the native adapter's turn"
```

---

### Task 8: Pre-merge live probe — consecutive user messages

**Files:**
- Create: `scripts/probe-consecutive-user-messages.ts` (throwaway; deleted in this task's final step)

The compacted array is `[user(pinned), user(summary), ...kept]`, and when the cut lands on a user message, three consecutive user messages. Our transcripts contain none today. pi ships two-in-a-row against real providers, which is evidence for two and not proof for three.

**A scripted test proves our mapping, never a provider's behaviour.** This task is the only way to know.

- [ ] **Step 1: Write the probe**

```ts
#!/usr/bin/env bun
/** Throwaway. Sends three consecutive user messages to a real provider. */
import { createClient, defaultProtocols, defaultProviders } from "@nathapp/nax-ai";

const [provider, model] = (process.argv[2] ?? "").split("/");
if (!provider || !model) {
  console.error("usage: bun scripts/probe-consecutive-user-messages.ts <provider>/<model>");
  process.exit(1);
}

const client = createClient({ providers: await defaultProviders(), protocols: defaultProtocols() });
const resolved = await client.model(provider, model);

try {
  const res = await client.complete(resolved, {
    messages: [
      { role: "user", content: "The task: reply with the single word OK." },
      { role: "user", content: "The conversation history before this point was compacted into a summary." },
      { role: "user", content: "Continue." },
    ],
    maxTokens: 16,
  });
  console.log(`ACCEPTED by ${provider}/${model}: ${JSON.stringify(res.text)}`);
} catch (err) {
  console.error(`REJECTED by ${provider}/${model}:`, err instanceof Error ? err.message : String(err));
  process.exit(2);
}
```

- [ ] **Step 2: Run it against Anthropic**

Run: `bun scripts/probe-consecutive-user-messages.ts anthropic/claude-sonnet-5`
Record the exact output in the PR description — accepted or the verbatim rejection message.

- [ ] **Step 3: Run it against an OpenAI-family provider**

Run: `bun scripts/probe-consecutive-user-messages.ts openai/gpt-5.4-mini`
Record the exact output.

- [ ] **Step 4: If either rejected, apply the decided fallback**

Do not redesign. In `applyCompaction`, merge the summary into the pinned message instead of adding a second one:

```ts
export function applyCompaction(
  messages: readonly TranscriptMessage[],
  plan: CompactionPlan,
  summary: string,
): TranscriptMessage[] {
  const pin = messages[PIN_INDEX] as TranscriptMessage;
  const pinContent = pin.role === "user" ? pin.content : "";
  return [
    { role: "user", content: `${pinContent}\n\n${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}` },
    ...messages.slice(plan.cutIndex),
  ];
}
```

Then update `readPreviousSummary` to search inside `messages[PIN_INDEX].content` for the prefix, and update the two `applyCompaction` tests in Task 2 that assert `out[0]` is byte-identical and `out[1]` carries the prefix. Note in the PR that the pinned prompt's cache block is given up, and why.

- [ ] **Step 5: Delete the probe**

```bash
rm scripts/probe-consecutive-user-messages.ts
```

The probe's output is an answer recorded in the PR, not code we keep.

- [ ] **Step 6: Final verification and commit**

Run: `bun run test`
Expected: all phases pass.
Run: `bun run typecheck && bun run lint`
Expected: clean.

```bash
git add -A
git commit -m "test: record the consecutive-user-message probe result"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: module and seams → Tasks 1, 2, 5; resolved-primitive config path → Task 3; the gate extension the spec calls for → Task 4; estimation, threshold, pinning, cut point, array building → Tasks 1 and 2; aggressive mode → Task 6; config surface → Task 3; error handling (failed summary, deadline, watchdog usage emission, degenerate cases, cost and counting) → Tasks 5 and 6; testing → the test steps throughout; the pre-merge live probe → Task 8. The two *Out of scope* items (persisting usage in the transcript file, pre-compaction snapshots) correctly have no task, and #1840 stays untouched.

**Type consistency.** `TranscriptMessage` is defined in Task 1 and imported under that name in Tasks 2, 5, 6; `turn-loop.ts` aliases it back to `NativeTranscriptMessage` so no unrelated line changes. `ResolvedCompaction` is defined in Task 1 and consumed in Tasks 3, 5, 6, 7. `CompactionPlan` is produced by `prepareCompaction` in Task 2 and consumed by `applyCompaction` in the same task and by the loop in Tasks 5 and 6. `NativeSummaryResponse` is defined in Task 5 and satisfied by the adapter in Task 7. `keepBudget`'s third parameter is `aggressive` in Task 1 and called that way in Task 6.

**One deliberate ordering constraint.** Task 4's gate must land before or with Task 3's config work is merged, because Task 3 is what introduces the temptation to read `NaxConfig` from native. It is placed after Task 3 so the probe in its Step 1 has something real to protect, but the two must ship in the same PR.

**Seven defects found in this plan during review and fixed inline**, recorded so a reviewer knows they were considered rather than missed. The last three were found by *running* the plan's code against the plan's own fixtures in a scratch test, not by reading it — reading had already passed them:

1. Task 5 referenced `nativeSessionLastUsage` without importing it. The import is now an explicit step.
2. Task 5's "at most once" test used `toolCalls: [] as never[]` — a loose cast the escape-hatch ratchet rejects, and an empty array ends the turn, so the test proved nothing. Replaced with a summary large enough to leave the transcript still over the threshold, asserting exactly one call.
3. Tasks 5 and 6 mutated `messages` in place (`messages.length = 0; push(...)`). Now rebinds, which needs `const messages` to become `let messages` — called out where it happens.
4. Task 7's window test was a tautology: it asserted `MODEL.contextWindow === 128_000`, a fact about the fixture, not about the wiring. Replaced with a behavioural test where the only way a summarize call occurs is if the real window reached the turn loop, plus its negative case on a large window.
5. **`findCutPoint` returned an out-of-range index.** A single backwards pass that remembers the last valid index it saw returns `messages.length` whenever trailing tool-results consume the budget before any valid cut appears. Measured against Task 2's own first test: `cut=5` on a 5-element array, so `messages[cut].role` throws. Replaced with a two-pass version that collects valid cuts first; re-measured, the same test now yields `assistant`, and the all-budgets sweep yields zero tool-result cuts.
6. **Task 2's `applyCompaction` fixtures produced no plan at all.** With two 1000-token exchanges and a 1000-token keep budget, `prepareCompaction` correctly returns `undefined` — so every assertion in that block was unreachable and `expect(plan).toBeDefined()` would fail. Re-derived to four 100-token exchanges with a 250-token budget, which yields a real cut at index 7 of 9.
7. **Task 6's backstop could never fire.** At a 1,000,000-token window the aggressive keep budget is 150,000 tokens — more than the entire test transcript — so `prepareCompaction` returns `undefined` and the backstop rethrows instead of retrying. Re-derived to a 20,000-token window (threshold 15,904, aggressive keep 3,000) with an ~8,006-token transcript: below the proactive threshold, above the aggressive budget, so only the backstop can be responsible for the compaction. The reasoning is written into the fixture's comment so nobody "simplifies" the numbers back.
