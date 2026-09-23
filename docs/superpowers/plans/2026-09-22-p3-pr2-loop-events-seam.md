# P3 PR 2 — the loop-event seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the native loop-event registry from two synchronous events to six async-capable ones, with the cache-boundary contract enforced mechanically in the dispatcher, and migrate the truncation policy into a registered `after_tool` handler.

**Architecture:** A typed event map replaces today's method-pair-per-event registry. Dispatch becomes async with a by-reference fast path when no handler is registered. A `cache-boundary.ts` checker rejects off-boundary history rewrites. Each event dispatches from exactly one place, which PR 1's extraction is what made possible.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-22-p3-loop-events-design.md` — read §3 (the cache-boundary rule, all seven subsections), §4 (registry shape), §6.0 (post-extraction homes), §6.1 (the event table), §6.5 (the `request()` wrapper), §6.6 (wire-copy ruling) and §7 (truncation migration) before Task 1.

**Baseline:** `main` @ `f849ca9b7` (PR #2186, the extraction). Branch `feat/p3-loop-events-seam`.

## Global Constraints

- **PR 2 adds NO production consumer for the five new events.** They are proven by test handlers. The only production wiring is §7's truncation migration onto the *existing* `after_tool`. nax#2150 is PR 3 — do not add `model` to `TranscriptFile` here.
- **Unlike PR 1, this PR MAY add tests** — it adds behaviour. It still may not *weaken* an existing test. If an existing assertion has to change, that is a behaviour change in a PR whose events all ship dormant: **stop and report it.**
- **Every new event ships with zero registered handlers by default.** `createLoopEventRegistry()` returns a registry whose new events dispatch to nothing, so a run with no handler behaves byte-identically to `f849ca9b7`.
- **600-line limit** under `src/`, `scripts/check-file-sizes.ts` (`SRC_LIMIT = 600`). `turn-loop.ts` is at 290 after PR 1 — budget exists, but `loop-events/` is split by §4.5 regardless.
- **Prompt-cache invariant:** nothing may rewrite the message-array prefix mid-session outside a cache boundary. This PR builds the mechanism that enforces it; it must not violate it.
- **Bun-native APIs only. No `any` in public APIs.** TypeScript strict.
- **Preserve moved comments verbatim**, with their issue references (nax#2045, #2047, #2120, #2151, #2162, ADR-028 §8, ADR-029 §5).
- Full suite `bun run test`; targeted `bun test <path> --timeout=30000` (never bare). Gates `bun run typecheck`, `bun run lint`.

```bash
TURN_TESTS="test/unit/agents/native/turn-loop.test.ts test/unit/agents/native/turn-loop-usage.test.ts test/unit/agents/native/turn-loop-compaction.test.ts test/unit/agents/native/turn-loop-transport-retry.test.ts test/unit/agents/native/session/turn-loop-seam.test.ts test/unit/agents/native/session/turn-loop-seam-regressions.test.ts test/unit/agents/native/session/turn-loop-invalid-input.test.ts test/unit/agents/native/session/native-truncation-nudge.test.ts test/unit/agents/native/session/native-truncation-chokepoint.test.ts test/unit/agents/native/session/us-003-acs.test.ts test/unit/agents/native/session/session-lifetime-spin.test.ts test/unit/agents/native/adapter.test.ts test/unit/agents/native/adapter-complete-rates.test.ts test/unit/agents/native/session/loop-events.test.ts"
```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/agents/native/session/loop-events/types.ts` | Create | Event map, per-event payload and patch types |
| `src/agents/native/session/loop-events/registry.ts` | Create | Async dispatcher, the four invariants, the empty fast path |
| `src/agents/native/session/loop-events/cache-boundary.ts` | Create | §3's prefix checker |
| `src/agents/native/session/loop-events/index.ts` | Create | Barrel — re-exports today's public names so importers do not churn |
| `src/agents/native/session/loop-events.ts` | Delete | Replaced by the directory (Task 2) |
| `src/agents/native/session/truncation-handler.ts` | Modify | Becomes a registered handler factory |
| `src/agents/native/session/loop-handlers.ts` | Modify | Registers truncation alongside the two `before_tool` built-ins |
| `src/agents/native/session/turn-complete-step.ts` | Modify | The `request()` wrapper; `transform_context` + `before_request` |
| `src/agents/native/session/turn-compaction-step.ts` | Modify | `before_compaction` in both functions |
| `src/agents/native/session/turn-tool-batch.ts` | Modify | Await the async `afterTool`; drop the hardcoded truncation call |
| `src/agents/native/session/turn-loop.ts` | Modify | `before_turn`, `after_response`, `before_turn_end` |
| `src/agents/native/session/turn-types.ts` | Modify | §6.3's per-call options bag on `TurnDeps.complete` |

**Task order is dependency order.** Tasks 1-3 build the seam with no new events wired; Tasks 4-8 wire one event each; Task 9 migrates truncation; Task 10 verifies.

---

### Task 1: The event map and payload types

**Files:**
- Create: `src/agents/native/session/loop-events/types.ts`
- Test: `test/unit/agents/native/session/loop-events/types.test.ts` (type-level only — see Step 3)

**Interfaces:**
- Produces: `LoopEvent` union, `LoopEventMap`, `HandlerOf<E>`, `PayloadOf<E>`, `PatchOf<E>`, and the six new payload/patch interfaces. Every later task consumes these by name.

- [ ] **Step 1: Read the existing contract you are preserving**

```bash
sed -n '1,80p' src/agents/native/session/loop-events.ts
```

The four invariants in that docblock (`:11-26`) are the contract. They move to `registry.ts` in Task 2 **verbatim**, extended per §4.7.

**`AfterToolPatch`, `AfterToolPayload` and `BeforeToolOutcome` MOVE into `types.ts` in this task, byte-identical.** `loop-events.ts` is deleted in Task 2, so they have to live somewhere; copy them across unchanged, docblocks included (the `denied`-is-not-patchable docblock cites ADR-029 §5 and is the only record of that rule). Renaming or reshaping them would ripple into `loop-handlers.ts` and four test files for no gain.

Verified current shape (`loop-events.ts:46-56`) — do not "improve" it:

```typescript
export type AfterToolPatch = { content?: string; isError?: boolean };

export interface AfterToolPayload {
  readonly content: string;
  readonly isError?: boolean;
  /** Surfaced to handlers, never writable by them. */
  readonly denied?: DenialInfo;
}
```

**`BeforeToolPayload` is NEW** and belongs in `types.ts` too — `before_tool` takes two arguments today (`(call, tools)`), and `HandlerOf<E>` is single-payload:

```typescript
export interface BeforeToolPayload {
  readonly call: ToolCall;
  readonly tools: readonly ToolDefinition[];
}
```

- [ ] **Step 2: Write the types**

```typescript
/**
 * The native session's loop-event map (nax#2151, P3).
 *
 * pi's `before_run`/`before_run_end` are `before_turn`/`before_turn_end` here:
 * `runNativeTurn` is ONE TURN, while a nax "run" holds many stories each
 * holding many turns, and `src/hooks/` already fires genuine run-level events.
 * Keeping the vocabularies disjoint is the same reasoning ADR-030's D11 applied
 * to the bash mode axis.
 *
 * `before_payload`, `before_drive` and `before_navigation` are deliberately
 * absent: the payload is built inside nax-ai behind the import boundary, and
 * nax has no branch navigation.
 */

import type { ThinkingBlock, ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import type { TokenUsage } from "@/agents/session-types";
import type { TranscriptMessage as NativeTranscriptMessage } from "../compaction";
import type { DenialInfo } from "../tool-result";

export type LoopEvent =
  | "before_tool"
  | "after_tool"
  | "before_turn"
  | "transform_context"
  | "before_request"
  | "after_response"
  | "before_compaction"
  | "before_turn_end";

/** `before_turn` — fires once as a turn starts, after the transcript loads. */
export interface BeforeTurnPayload {
  readonly prompt: string;
  /** The loaded transcript. Readonly: only a boundary rewrite may touch it. */
  readonly history: readonly NativeTranscriptMessage[];
  readonly sessionName: string;
  /** PR 3 populates these from TranscriptFile.model; undefined until then. */
  readonly previousModel?: string;
  readonly currentModel?: string;
  /** Dispatcher-computed (spec 3.4). A handler may never assert a boundary. */
  readonly boundary: boolean;
}

export interface BeforeTurnPatch {
  /** The seed messages being appended now. */
  readonly seed?: readonly NativeTranscriptMessage[];
  /** Honoured ONLY when payload.boundary is true (spec 3.2, 6.1). */
  readonly history?: readonly NativeTranscriptMessage[];
}

/** `transform_context` — fires before every provider request attempt. */
export interface TransformContextPayload {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly model?: string;
  readonly anchorIndex?: number;
  readonly boundary: boolean;
}

export interface TransformContextPatch {
  readonly messages?: readonly NativeTranscriptMessage[];
}

/** `before_request` — per request ATTEMPT, including transport retries. */
export interface BeforeRequestPayload {
  readonly model?: string;
  readonly roundTrip: number;
  /** 1 for the first attempt, 2..n inside retryTransportFault. */
  readonly attempt: number;
  readonly options: CompleteCallOptions;
}

export interface BeforeRequestPatch {
  readonly options?: Partial<CompleteCallOptions>;
}

/**
 * The per-call options bag added to TurnDeps.complete in Task 4 (spec 6.3).
 * Minimal and additive by ruling: P6's extraction inherits one optional
 * parameter, not a new concept.
 */
export interface CompleteCallOptions {
  readonly thinking?: boolean;
  readonly temperature?: number;
}

/** `after_response` — fires on a settled assistant message. */
export interface AfterResponsePayload {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
  /** Surfaced, NEVER patchable: billing truth is not a handler's to rewrite. */
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly roundTrip: number;
}

export interface AfterResponsePatch {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly thinking?: readonly ThinkingBlock[];
}

⚠️ **Use `ThinkingBlock` from `@nathapp/nax-ai`, never a hand-rolled `{ text: string }`.**
`NativeTurnResponse.thinking` is `readonly ThinkingBlock[]` (`turn-types.ts:29`), and a
structural stand-in would compile until the block gains a field, then silently drop it — which
is exactly nax#2150's `thinkingSignature` problem in a new place.

/** `before_compaction` — fires in both the proactive and overflow branches. */
export interface BeforeCompactionPayload {
  readonly reason: "proactive" | "overflow";
  readonly toSummarize: readonly NativeTranscriptMessage[];
  readonly previousSummary?: string;
  readonly estimatedTokens: number;
}

export interface BeforeCompactionPatch {
  /** Honoured when reason is "proactive", IGNORED + logged when "overflow". */
  readonly decline?: boolean;
  /** A replacement summary, skipping the summarizer call. */
  readonly summary?: string;
}

/** `before_turn_end` — fires before the final saveTranscript. */
export interface BeforeTurnEndPayload {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly roundTrips: number;
  /** True when the turn ended by a STOP; followUp is not offered then. */
  readonly stopped: boolean;
  readonly followUpsSoFar: number;
}

export interface BeforeTurnEndPatch {
  /** Re-enters the loop with another user turn. Capped; see registry.ts. */
  readonly followUp?: string;
}
```

Then the map, reusing the two existing shapes unchanged:

```typescript
export interface LoopEventMap {
  before_tool: { payload: BeforeToolPayload; patch: BeforeToolOutcome };
  after_tool: { payload: AfterToolPayload; patch: AfterToolPatch };
  before_turn: { payload: BeforeTurnPayload; patch: BeforeTurnPatch };
  transform_context: { payload: TransformContextPayload; patch: TransformContextPatch };
  before_request: { payload: BeforeRequestPayload; patch: BeforeRequestPatch };
  after_response: { payload: AfterResponsePayload; patch: AfterResponsePatch };
  before_compaction: { payload: BeforeCompactionPayload; patch: BeforeCompactionPatch };
  before_turn_end: { payload: BeforeTurnEndPayload; patch: BeforeTurnEndPatch };
}

export type PayloadOf<E extends LoopEvent> = LoopEventMap[E]["payload"];
export type PatchOf<E extends LoopEvent> = LoopEventMap[E]["patch"];
export type HandlerOf<E extends LoopEvent> = (payload: PayloadOf<E>) => PatchOf<E> | Promise<PatchOf<E>>;
```

⚠️ `before_tool` today takes **two** arguments `(call, tools)`, not a single payload. Introduce `BeforeToolPayload = { call: ToolCall; tools: readonly ToolDefinition[] }` and adapt at the dispatch site in Task 2, so `HandlerOf` stays uniform. `loop-handlers.ts` changes with it; that is the one existing-handler signature change in this PR and it is mechanical.

- [ ] **Step 3: Write a type-level test**

Runtime tests come with the registry in Task 2. Here, pin that the map is exhaustive — a new `LoopEvent` member with no map entry must fail typecheck:

```typescript
import { describe, expect, test } from "bun:test";
import type { LoopEvent, LoopEventMap } from "@/agents/native/session/loop-events/types";

describe("loop event map", () => {
  test("every LoopEvent member has a map entry", () => {
    // Compile-time exhaustiveness: this assignment fails to typecheck if a
    // LoopEvent member is missing from LoopEventMap.
    type Missing = Exclude<LoopEvent, keyof LoopEventMap>;
    const none: Missing[] = [];
    expect(none).toEqual([]);
  });

  test("the eight events are the full set", () => {
    const all: LoopEvent[] = [
      "before_tool", "after_tool", "before_turn", "transform_context",
      "before_request", "after_response", "before_compaction", "before_turn_end",
    ];
    expect(new Set(all).size).toBe(8);
  });
});
```

- [ ] **Step 4: Run it**

Run: `bun test test/unit/agents/native/session/loop-events/types.test.ts --timeout=30000`
Expected: PASS. Then `bun run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/loop-events/types.ts test/unit/agents/native/session/loop-events/types.test.ts
git commit -m "feat(native): loop-event map and payload types for the full event set

Eight events in one typed map, replacing a method pair per event. pi's
before_run/before_run_end are before_turn/before_turn_end here, because
runNativeTurn is one TURN and nax already uses 'run' for the orchestration that
holds many of them.

Payload/patch shapes encode the stop rules the dispatcher enforces next:
after_response surfaces usage and costUsd as readonly, before_compaction's
decline is only meaningful when reason is proactive, and before_turn's history
patch is gated on a dispatcher-computed boundary flag a handler cannot assert.

Types only; nothing dispatches them yet."
```

---

### Task 2: The async registry

**Files:**
- Create: `src/agents/native/session/loop-events/registry.ts`, `loop-events/index.ts`
- Delete: `src/agents/native/session/loop-events.ts`
- Modify: `src/agents/native/session/loop-handlers.ts` (the `before_tool` payload shape)
- Test: `test/unit/agents/native/session/loop-events/registry.test.ts`

**Interfaces:**
- Consumes: Task 1's types
- Produces: `createLoopEventRegistry(): LoopEventRegistry` with `register<E>(event, handler)` and `dispatch<E>(event, payload): Promise<PatchOf<E>>`. `index.ts` re-exports `createLoopEventRegistry`, `LoopEventRegistry`, `buildToolResult`, `BuildToolResultArgs`, `DenialInfo`, `ToolResultMessage`, `AfterToolPatch`, `AfterToolPayload`, `BeforeToolOutcome` — **every name `loop-events.ts` exports today**, so no importer churns.

- [ ] **Step 1: Inventory what must keep working**

```bash
grep -rn "from \"./loop-events\"\|from \"@/agents/native/session/loop-events\"" src/ test/
```

Every one of those must still resolve after the file becomes a directory. `index.ts` is what guarantees it. Run this again in Step 6 and confirm the same list.

- [ ] **Step 2: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";

describe("loop event registry", () => {
  test("dispatch returns the input by reference when no handler is registered", async () => {
    const registry = createLoopEventRegistry();
    const payload = { messages: [{ role: "user", content: "x" }], tools: [], boundary: false } as const;
    const patch = await registry.dispatch("transform_context", payload);
    // The empty fast path must not clone: transform_context fires before every
    // request against a 200k+ token array (spec 4.4).
    expect(patch.messages).toBeUndefined();
  });

  test("handlers chain in registration order", async () => {
    const registry = createLoopEventRegistry();
    const seen: string[] = [];
    registry.register("after_response", (p) => { seen.push(`a:${p.text}`); return { text: `${p.text}1` }; });
    registry.register("after_response", (p) => { seen.push(`b:${p.text}`); return { text: `${p.text}2` }; });
    const patch = await registry.dispatch("after_response", {
      text: "x", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, roundTrip: 1,
    });
    expect(seen).toEqual(["a:x", "b:x1"]);
    expect(patch.text).toBe("x12");
  });

  test("a THROWING handler is logged and skipped, later handlers still run", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_response", () => { throw new Error("boom"); });
    registry.register("after_response", (p) => ({ text: `${p.text}!` }));
    const patch = await registry.dispatch("after_response", {
      text: "x", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, roundTrip: 1,
    });
    expect(patch.text).toBe("x!");
  });

  test("a REJECTING handler is logged and skipped, later handlers still run", async () => {
    // spec 4.2: the existing try/catch catches a throw but NOT a rejected
    // promise unless the await is inside the try. Both must behave identically.
    const registry = createLoopEventRegistry();
    registry.register("after_response", () => Promise.reject(new Error("boom")));
    registry.register("after_response", (p) => ({ text: `${p.text}!` }));
    const patch = await registry.dispatch("after_response", {
      text: "x", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, roundTrip: 1,
    });
    expect(patch.text).toBe("x!");
  });

  test("usage and costUsd are not patchable on after_response", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_response", () => ({ usage: { inputTokens: 999, outputTokens: 999 } } as never));
    const patch = await registry.dispatch("after_response", {
      text: "x", usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 3, roundTrip: 1,
    });
    expect((patch as { usage?: unknown }).usage).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test test/unit/agents/native/session/loop-events/registry.test.ts --timeout=30000`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement the registry**

Move the four-invariant docblock from `loop-events.ts:1-26` **verbatim** into `registry.ts`, then extend it with §4.2 (rejections) and §4.7 (invariant 4 is now mechanical).

Shape:

```typescript
export interface LoopEventRegistry {
  register<E extends LoopEvent>(event: E, handler: HandlerOf<E>): void;
  dispatch<E extends LoopEvent>(event: E, payload: PayloadOf<E>): Promise<PatchOf<E>>;
}
```

Core rules, each already pinned by a test above:

1. `const handlers = byEvent.get(event); if (handlers === undefined || handlers.length === 0) return {} as PatchOf<E>;` — **return before touching the payload**, never clone.
2. Serial `for`, each handler awaited **inside** the `try`, so a rejection is caught exactly like a throw.
3. Accumulate patches in registration order, each handler seeing the previous one's output.
4. Read only the fields the patch type declares — a handler returning `usage` on `after_response` must not surface one. This is the same defence `afterTool` already applies to `denied` (`loop-events.ts:158-159`, "Only the patchable fields are read, so a handler that returns a denied-bearing object (bypassing the type) cannot surface one").
5. `before_tool`'s `block`/`terminate` short-circuit, exactly as today.

- [ ] **Step 5: Adapt `loop-handlers.ts`**

`registerBuiltinLoopHandlers` changes from `registry.registerBeforeTool((call, tools) => ...)` to `registry.register("before_tool", ({ call, tools }) => ...)`. **Keep the `WeakMap<LoopEventRegistry, BuiltinTurnState>` repoint at `:44-51` exactly as it is** (§4.6) — it is the lifetime pattern the new events use too.

- [ ] **Step 6: Delete the old file and verify no importer broke**

```bash
git rm src/agents/native/session/loop-events.ts
grep -rn "from \"./loop-events\"\|from \"@/agents/native/session/loop-events\"" src/ test/
bun run typecheck
```

Expected: the same importer list as Step 1, all resolving through `index.ts`; typecheck clean.

- [ ] **Step 7: Run the new tests and the 14 regression files**

```bash
bun test test/unit/agents/native/session/loop-events/registry.test.ts --timeout=30000
bun test $TURN_TESTS --timeout=30000
```

Expected: both PASS. `loop-events.test.ts` and `turn-loop-seam.test.ts` exercise the two existing events through the changed dispatcher — if either fails, the adaptation changed behaviour.

⚠️ The two existing dispatch call sites are **synchronous today** (`turn-tool-batch.ts:190,221` and the `before_tool` site). Making `dispatch` async means those callers must `await`. Both are already inside `async` functions, so this is adding `await`, not restructuring.

- [ ] **Step 8: Commit**

```bash
git add -A src/agents/native/session/loop-events src/agents/native/session/loop-handlers.ts test/unit/agents/native/session/loop-events/
git commit -m "feat(native): async loop-event registry with a typed event map

register(event, handler) / dispatch(event, payload) replace a method pair per
event, so a new event no longer edits the interface. Dispatch is async: the
truncation policy could not be a registered after_tool handler while it was
synchronous, which is the concrete cost that motivated this.

A REJECTED promise is now logged-and-skipped identically to a throw. The old
try/catch caught only the throw, and every event's suite pins both.

The empty fast path returns before touching the payload: transform_context
fires before every request against a 200k+ token array, so cloning for an
empty chain would have made every request allocate a full copy for nothing.

loop-events.ts becomes loop-events/ with a barrel re-exporting every name it
exported, so no importer changes. No new event is wired yet."
```

---

### Task 3: The cache-boundary checker

**Files:**
- Create: `src/agents/native/session/loop-events/cache-boundary.ts`
- Test: `test/unit/agents/native/session/loop-events/cache-boundary.test.ts`

**Interfaces:**
- Produces: `checkPrefixStable(before, after, anchorIndex): boolean` and `applyHistoryPatch<T>(args): { messages, honoured }`

Read spec §3 **in full** before this task — all seven subsections. This is the design's spine.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test";
import { checkPrefixStable } from "@/agents/native/session/loop-events/cache-boundary";

const m = (content: string) => ({ role: "user" as const, content });

describe("prefix stability checker", () => {
  test("an unchanged prefix passes", () => {
    const a = m("1"), b = m("2"), c = m("3");
    expect(checkPrefixStable([a, b, c], [a, b, c], 1)).toBe(true);
  });

  test("appending past the anchor passes", () => {
    const a = m("1"), b = m("2"), c = m("3");
    // Elements after the anchor are new and uncached, so rewriting them is free.
    expect(checkPrefixStable([a, b], [a, b, c], 1)).toBe(true);
  });

  test("replacing an element before the anchor fails", () => {
    const a = m("1"), b = m("2"), c = m("3");
    expect(checkPrefixStable([a, b, c], [a, m("2"), c], 1)).toBe(false);
  });

  test("an EQUAL-VALUED rebuild before the anchor fails", () => {
    // Reference identity, not deep equality (spec 3.2): a rebuilt object has
    // still broken the provider's prefix-matched cache.
    const a = m("1"), b = m("2");
    expect(checkPrefixStable([a, b], [{ ...a }, b], 1)).toBe(false);
  });

  test("truncating below the anchor fails", () => {
    const a = m("1"), b = m("2"), c = m("3");
    expect(checkPrefixStable([a, b, c], [a], 1)).toBe(false);
  });

  test("an undefined anchor permits a full rewrite", () => {
    // spec 3.5: undefined means there IS no cached prefix — a fresh session,
    // or straight after a compaction. Positive knowledge, not ignorance.
    const a = m("1"), b = m("2");
    expect(checkPrefixStable([a, b], [m("z")], undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/unit/agents/native/session/loop-events/cache-boundary.test.ts --timeout=30000`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
export function checkPrefixStable(
  before: readonly unknown[],
  after: readonly unknown[],
  anchorIndex: number | undefined,
): boolean {
  // No anchor means no cached prefix to protect (spec 3.5).
  if (anchorIndex === undefined) return true;
  const end = Math.min(anchorIndex, before.length - 1);
  if (after.length <= end) return false;
  for (let i = 0; i <= end; i += 1) {
    // Reference identity: an equal-valued rebuild still breaks the wire cache.
    if (before[i] !== after[i]) return false;
  }
  return true;
}
```

Then `applyHistoryPatch`, the single place both `transform_context` and `before_turn` route through:

```typescript
export function applyHistoryPatch<T>(args: {
  readonly before: readonly T[];
  readonly patched: readonly T[] | undefined;
  readonly anchorIndex: number | undefined;
  readonly boundary: boolean;
  readonly event: string;
}): { readonly messages: readonly T[]; readonly honoured: boolean } {
  const { before, patched, anchorIndex, boundary, event } = args;
  if (patched === undefined) return { messages: before, honoured: false };
  if (boundary || checkPrefixStable(before, patched, anchorIndex)) {
    return { messages: patched, honoured: true };
  }
  getSafeLogger()?.warn("native-loop-events", "history patch rejected: prefix rewritten off-boundary", {
    event,
    ...(anchorIndex !== undefined ? { anchorIndex } : {}),
  });
  // What stops is the PATCH, never the turn (spec 3.7).
  return { messages: before, honoured: false };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test test/unit/agents/native/session/loop-events/cache-boundary.test.ts --timeout=30000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/loop-events/cache-boundary.ts test/unit/agents/native/session/loop-events/cache-boundary.test.ts
git commit -m "feat(native): mechanical prefix-stability checker for history patches

The contract the master plan's D6 proposed writing into a docblock is enforced
in code instead: a history-rewriting patch is honoured only at a cache
boundary, and off-boundary it is rejected with the original kept and a warn
logged. What stops is the patch, never the turn.

Reference identity rather than deep equality, because a handler that rebuilds
an equal-valued message has still broken the provider's prefix-matched cache.
An undefined anchor permits a full rewrite: it means there is no cached prefix
(fresh session, or straight after a compaction), which is positive knowledge
rather than ignorance.

Not wired to an event yet."
```

---

### Task 4: `before_request` and the per-call options bag

**Files:**
- Modify: `src/agents/native/session/turn-types.ts` (`TurnDeps.complete`), `src/agents/native/session/turn-complete-step.ts` (the `request()` wrapper)
- Test: `test/unit/agents/native/session/loop-events/before-request.test.ts`

**Interfaces:**
- Consumes: Task 1's `BeforeRequestPayload`, `CompleteCallOptions`
- Produces: `TurnDeps.complete(messages, tools, options?)`; a private `request()` in `turn-complete-step.ts` that Task 5 also dispatches `transform_context` from

- [ ] **Step 1: Confirm the three call sites**

```bash
grep -n "deps.complete" src/agents/native/session/turn-complete-step.ts
```

Expected: `:63` (primary), `:82` (inside `retryTransportFault`'s `attempt` closure), `:131` (post-overflow retry). **All three route through `request()`** (spec §6.5). Dispatching at each by hand is the drift this seam exists to prevent.

🚨 **Three things the step does not have today and must be threaded into `CompleteStepArgs`** (verified on `f849ca9b7` — `CompleteStepArgs` is `turn-complete-step.ts:41-55`, `TurnDeps` is `turn-types.ts:53-113`):

| needed | where it lives now | note |
|---|---|---|
| `loopEvents` | `turn-loop.ts:94`, a local | **`deps.loopEvents` is NOT it.** `turn-loop.ts` does `deps.loopEvents ?? createLoopEventRegistry()`, so the registry actually in use is usually not on `deps`. Pass it explicitly, exactly as `runToolBatch` already receives it (`turn-loop.ts:227`). |
| `roundTrip` | `turn-loop.ts`, the `roundTrips` local | Not on `CompleteStepArgs`. |
| `model` | `handle.modelDef?.model` | **`TurnDeps` has no `model` field** — confirm with `grep -n "model" src/agents/native/session/turn-types.ts`. Thread it from `turn-loop.ts`, which has `handle`. |

Add all three to `CompleteStepArgs` as part of this task. `model` stays optional: a session driven without a `modelDef` (unit tests calling `runNativeTurn` directly) has none, and `undefined` is the honest value.

- [ ] **Step 2: Widen `TurnDeps.complete`**

```typescript
complete(
  messages: readonly ConversationMessage[],
  tools: ReturnType<typeof toToolDefinitions>,
  options?: CompleteCallOptions,
): Promise<NativeTurnResponse>;
```

**Optional, so every existing caller and test fake compiles unchanged.** Keep the bag minimal and additive (spec §6.3's recorded constraint) — it widens the adapter/session boundary P6 cares about.

- [ ] **Step 3: Write the failing test**

```typescript
test("before_request fires per ATTEMPT, with attempt incrementing on retry", async () => {
  const attempts: number[] = [];
  const registry = createLoopEventRegistry();
  registry.register("before_request", (p) => { attempts.push(p.attempt); return {}; });
  // deps.complete throws a transport fault once, then succeeds.
  // ... drive runNativeTurn with transportRetry configured ...
  expect(attempts).toEqual([1, 2]);
});
```

Model the fake on `turn-loop-transport-retry.test.ts`, which already builds a transport-fault double — **reuse its helper rather than writing a second one** (`check-inline-test-mocks.ts` enforces this).

- [ ] **Step 4: Run to verify it fails**

Expected: FAIL — `attempts` is `[]`, nothing dispatches yet.

- [ ] **Step 5: Implement `request()`**

```typescript
// One wrapper, three call sites (spec 6.5). The wrapper owns `attempt`, so
// the retry machinery reports 2..n without knowing an event exists.
let attempt = 0;
const request = async (msgs: readonly NativeTranscriptMessage[]): Promise<NativeTurnResponse> => {
  attempt += 1;
  const patch = await loopEvents.dispatch("before_request", {
    ...(model !== undefined ? { model } : {}),
    roundTrip, attempt, options: baseOptions,
  });
  const options = patch.options === undefined ? baseOptions : { ...baseOptions, ...patch.options };
  return deps.complete(msgs, tools, options);
};
```

Replace all three `deps.complete(...)` with `request(...)`, including the `attempt:` closure passed to `retryTransportFault`.

- [ ] **Step 6: Run to verify it passes, plus the regression files**

```bash
bun test test/unit/agents/native/session/loop-events/before-request.test.ts --timeout=30000
bun test $TURN_TESTS --timeout=30000
```

Expected: both PASS. `turn-loop-transport-retry.test.ts` is the discriminator.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/session/turn-types.ts src/agents/native/session/turn-complete-step.ts test/unit/agents/native/session/loop-events/before-request.test.ts
git commit -m "feat(native): before_request event and a per-call options bag

TurnDeps.complete gains an optional third argument so before_request has a real
write target; request options were bound in the adapter closure above the loop,
which left pi's version with nothing to patch. Optional, minimal and additive:
P6's extraction inherits one parameter, not a new concept.

deps.complete is invoked at THREE points inside completeWithRecovery, not one —
primary, transport retry, post-overflow retry. All three route through a single
request() wrapper that owns the attempt counter, so before_request fires per
attempt as pi specifies and the retry machinery stays unaware of the event."
```

---

### Task 5: `transform_context`

**Files:**
- Modify: `src/agents/native/session/turn-complete-step.ts` (inside `request()`)
- Test: `test/unit/agents/native/session/loop-events/transform-context.test.ts`

**Interfaces:** Consumes Task 3's `applyHistoryPatch`, Task 4's `request()`.

🚨 **Read spec §6.6 first.** The patch shapes **only the array passed to `deps.complete`**. The array the caller holds — the one `saveTranscript` persists — is untouched.

- [ ] **Step 1: Write the failing tests**

```typescript
test("an off-boundary prefix rewrite is rejected and the original is SENT", async () => {
  const sent: unknown[][] = [];
  const registry = createLoopEventRegistry();
  registry.register("transform_context", () => ({ messages: [{ role: "user", content: "hijacked" }] }));
  // ... drive a turn whose anchorIndex is defined; capture deps.complete's messages ...
  expect(sent[0]).not.toEqual([{ role: "user", content: "hijacked" }]);
});

test("the persisted transcript never carries a transform_context patch", async () => {
  // spec 6.6: wire copy only. Even an HONOURED patch must not reach saveTranscript.
  // ... register a handler that appends past the anchor (honoured), then read
  // the saved transcript and assert the appended message is absent ...
});
```

⚠️ **The second test is the one that matters** and it is the easy one to get wrong. Asserting only that `deps.complete` saw the patch would pass an implementation that also persisted it.

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL.

- [ ] **Step 3: Implement inside `request()`**

```typescript
const transformed = await loopEvents.dispatch("transform_context", {
  messages: msgs, tools, anchorIndex, boundary,
  ...(model !== undefined ? { model } : {}),
});
const wire = applyHistoryPatch({
  before: msgs, patched: transformed.messages, anchorIndex, boundary, event: "transform_context",
});
// `wire.messages` goes to the provider; `msgs` — the caller's array — is
// returned untouched, so saveTranscript persists the true conversation
// (spec 6.6).
return deps.complete(wire.messages, tools, options);
```

ℹ️ **Type note, verified:** the step holds `readonly NativeTranscriptMessage[]`
(`turn-complete-step.ts:59`) while `TurnDeps.complete` declares `readonly ConversationMessage[]`
(`turn-types.ts:55`). `TranscriptMessage` is `ConversationMessage` widened with the
coding-tool denial marker (`compaction.ts:22-31`, ADR-029 §5) and the call already typechecks
today, so the payload type is `NativeTranscriptMessage[]` and no conversion is introduced.

`boundary` is `compacted` for this step: `completeWithRecovery` knows whether the overflow branch just ran. A model change is a turn-start fact and belongs to `before_turn` (spec §8.2), so it is **not** consulted here.

- [ ] **Step 4: Verify the anchor is cleared on an honoured rewrite**

Per §6.6, an honoured boundary rewrite still clears `lastUsage`/`anchorIndex`, because the prefix the provider saw changed. Return `honoured` from the step and have `turn-loop.ts` clear on it, exactly as it already does for `compacted` (`turn-loop.ts:179`).

- [ ] **Step 5: Run, including regressions**

```bash
bun test test/unit/agents/native/session/loop-events/transform-context.test.ts --timeout=30000
bun test $TURN_TESTS --timeout=30000
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/native/session/turn-complete-step.ts src/agents/native/session/turn-loop.ts test/unit/agents/native/session/loop-events/transform-context.test.ts
git commit -m "feat(native): transform_context, gated by the prefix checker

Fires before every provider request attempt, from the same request() wrapper as
before_request. An off-boundary prefix rewrite is rejected, the original sent,
and a warn logged.

The patch shapes ONLY what deps.complete receives: in nax the message array is
both the transcript and the wire payload, and the ruling is that the persisted
transcript stays the true record. A handler that wants to rewrite the
conversation has before_turn; one that wants to shape a request has this.
Neither can do the other's job by accident.

An honoured boundary rewrite still clears lastUsage/anchorIndex, because the
prefix the provider saw changed even though the saved array did not."
```

---

### Task 6: `before_compaction`

**Files:**
- Modify: `src/agents/native/session/turn-compaction-step.ts` (both `runProactiveCompaction:95` and `runOverflowCompaction:143`)
- Test: `test/unit/agents/native/session/loop-events/before-compaction.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
test("decline is HONOURED in the proactive branch", async () => {
  // Registering a declining handler means the turn sends uncompacted.
  // ... assert deps.summarize was never called ...
});

test("decline is IGNORED in the overflow branch, and compaction still runs", async () => {
  // spec 6.2: the request has ALREADY failed with a context overflow. Declining
  // leaves no recovery and kills the story, so the SIGNAL stops, not the
  // compaction.
  // ... assert deps.summarize WAS called despite the decline ...
});

test("a replacement summary skips the summarizer call", async () => {
  // ... assert deps.summarize not called, and the compacted array carries the
  // handler's summary text ...
});
```

⚠️ The second test is the stop rule with teeth. An implementation that honours `decline` everywhere passes the first and third and fails only this one.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL.

- [ ] **Step 3: Implement in both functions**

⚠️ `CompactionStepArgs` (`turn-compaction-step.ts:46-54`) does **not** carry `loopEvents` either — thread it in the same way Task 4 threads it into `CompleteStepArgs`, from the `turn-loop.ts` local rather than from `deps`. Note its `deps` field is `CompactionStepDeps` (a narrowed subset), **not** `TurnDeps`, so widening `TurnDeps` does not reach this module.

Dispatch before `deps.summarize` in each. In `runOverflowCompaction`, when `decline` is returned:

```typescript
getSafeLogger()?.warn("native-loop-events", "before_compaction decline ignored at overflow", {
  sessionName,
});
```

and proceed. Do **not** add a shared helper that takes a `honourDecline: boolean` — the asymmetry is the point, and PR 1 already established that these two functions stay separate rather than collapsing behind a flag.

- [ ] **Step 4: Run, including `turn-loop-compaction.test.ts`**

```bash
bun test test/unit/agents/native/session/loop-events/before-compaction.test.ts --timeout=30000
bun test $TURN_TESTS --timeout=30000
```

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-compaction-step.ts test/unit/agents/native/session/loop-events/before-compaction.test.ts
git commit -m "feat(native): before_compaction in both branches, with an asymmetric decline

decline is honoured proactively and ignored at reactive overflow. At overflow
the request has already failed with a context-overflow error: there is no
uncompacted path left, so declining would kill the story. The signal stops, the
compaction does not, and the ignore is logged.

Implemented in both functions rather than behind an honourDecline flag: the
asymmetry is the point, and a boolean would hide it."
```

---

### Task 7: `before_turn` and `after_response`

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts` (seed push `:52`, assistant push `:206`)
- Test: `test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
test("before_turn may shape the seed", async () => { /* seed patch applied */ });

test("before_turn may NOT rewrite loaded history off-boundary", async () => {
  // boundary is false until PR 3 populates previousModel/currentModel, so a
  // history patch is rejected and the loaded transcript is preserved.
});

test("after_response may rewrite text before it enters the array", async () => { /* ... */ });

test("after_response CANNOT patch usage or costUsd", async () => {
  // Billing truth is not a handler's to rewrite — the same rule as `denied`
  // on after_tool. The returned TurnResult must carry the real usage.
});
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

`before_turn` dispatches after `loadTranscript` and before the seed push, routing any `history` patch through `applyHistoryPatch` with `boundary: false` (PR 3 supplies the real value). `after_response` dispatches before `messages.push({role: "assistant", ...})` at `:206`, patching `text`/`toolCalls`/`thinking` only.

⚠️ `anchorIndex = messages.length - 1` at `:191` runs **before** the assistant push. Confirm `after_response` does not change the index it records — it shapes the message being pushed, not the array length.

- [ ] **Step 4: Run, including regressions** — `bun test $TURN_TESTS --timeout=30000`

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-loop.ts test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts
git commit -m "feat(native): before_turn and after_response

before_turn shapes the seed messages; its history channel exists but is gated
on a dispatcher-computed boundary that is false until PR 3 records the model on
TranscriptFile, so a history patch is rejected today.

after_response shapes the assistant message before it enters the array, which
makes it safe by construction. usage and costUsd are surfaced readonly and are
not patchable: billing truth is not a handler's to rewrite, the same rule
after_tool already applies to denied."
```

---

### Task 8: `before_turn_end` and the followUp cap

**Files:**
- Modify: `src/agents/native/session/turn-loop.ts` (before `buildTurnResult`, `:277`)
- Test: `test/unit/agents/native/session/loop-events/before-turn-end.test.ts`

**Interfaces:** Add `MAX_FOLLOW_UPS_PER_TURN = 3` as a named constant in `turn-loop.ts` (no magic numbers).

- [ ] **Step 1: Write the failing tests**

```typescript
test("followUp re-enters the loop with another user turn", async () => { /* ... */ });

test("followUp is capped per turn", async () => {
  // A handler returning followUp unconditionally must not loop forever.
  // Expect exactly MAX_FOLLOW_UPS_PER_TURN injections.
});

test("followUp is NOT offered after a spin-breaker stop", async () => {
  // spec 6.4: letting a handler resurrect a turn the breaker just killed
  // re-opens nax#2120 through the back door.
});

test("followUp is NOT offered after the invalid-call budget trips", async () => {
  // Same rule, nax#2047.
});

test("followUp is NOT offered after a deadline timeout", async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL.

- [ ] **Step 3: Implement**

Dispatch before `buildTurnResult`. Compute `stopped = spinStopped || invalidCallBudget.exceeded || timedOut` and **do not offer the followUp channel at all** when it is true — pass `stopped: true` in the payload and ignore any `followUp` returned. On an honoured followUp, push the user message and continue the outer loop; increment `followUpsSoFar`.

- [ ] **Step 4: Run, including `session-lifetime-spin.test.ts`** — `bun test $TURN_TESTS --timeout=30000`

- [ ] **Step 5: Commit**

```bash
git add src/agents/native/session/turn-loop.ts test/unit/agents/native/session/loop-events/before-turn-end.test.ts
git commit -m "feat(native): before_turn_end with a bounded followUp channel

The only event that can spend money on its own, so it carries two bounds: a cap
per turn, and no injection at all when the turn ended by a STOP — the spin
breaker (nax#2120), the invalid-call budget (nax#2047), or the deadline.
Resurrecting a turn a breaker just killed would re-open the loops those
breakers exist to close."
```

---

### Task 9: Migrate truncation into a registered `after_tool` handler

**Files:**
- Modify: `src/agents/native/session/truncation-handler.ts`, `loop-handlers.ts`, `turn-tool-batch.ts:190-199,221-224`, `loop-events/types.ts` (the nudge field)
- Test: existing `us-003-acs.test.ts` and `native-truncation-*.test.ts` are the regression spine

**This is PR 2's only production wiring.** Read spec §7.

- [ ] **Step 1: Read the exception being deleted**

```bash
sed -n '1,20p' src/agents/native/session/truncation-handler.ts
```

The docblock says "WHY THIS IS NOT A REGISTERED `after_tool` HANDLER, despite the seam being the right place for it conceptually: the dispatcher in `loop-events.ts` is synchronous by design ... while applying the policy has to await the spill write." Task 2 removed that reason. **Delete the paragraph and replace it with what is now true.**

- [ ] **Step 2: Add the nudge reserve to the payload**

`turn-tool-batch.ts:193-199` passes `reserveBytes: nudgeOverheadBytes(nudgeText)` so the nudge's bytes come out of the result's budget rather than being added after the ceiling. `AfterToolPayload` does not carry `nudgeText` today.

**Add `readonly nudgeText?: string` to `AfterToolPayload`**, or the reserve is silently lost and a nudged result exceeds its budget — a regression no existing assertion would catch, because the nudge tests assert content rather than byte totals.

- [ ] **Step 3: Convert to a handler factory**

```typescript
export function createTruncationHandler(sessionName: string): HandlerOf<"after_tool"> {
  return async (payload) => {
    const shaped = await truncateNativeToolResult(sessionName, payload.content, {
      toolName: payload.toolName,
      callId: payload.callId,
      ...(payload.nudgeText !== undefined ? { reserveBytes: nudgeOverheadBytes(payload.nudgeText) } : {}),
    });
    return { content: shaped };
  };
}
```

**Verified on `f849ca9b7`: `AfterToolPayload` is `{ content, isError?, denied? }` and carries NEITHER `toolName` NOR `callId`** (`loop-events.ts:50-56`). The dispatcher receives `call` as a separate first argument, which is exactly what Task 1's single-payload `HandlerOf<E>` removes. So all three fields — `toolName`, `callId`, `nudgeText` — are additions to `AfterToolPayload` in this task.

- [ ] **Step 4: Register it LAST**

In `registerBuiltinLoopHandlers`, register truncation **after** any other `after_tool` handler, so it shapes whatever earlier handlers produced — which is exactly what its current position after `loopEvents.afterTool(...)` means today (spec §7).

- [ ] **Step 5: Remove the hardcoded calls**

Delete the `await truncateNativeToolResult(...)` at `turn-tool-batch.ts:193` and `:222`; the dispatcher now returns already-shaped content. `withNudge(nudgeText, shaped)` and `answer?.finalizeAudit?.(finalContent)` stay in the batch — they are not truncation.

- [ ] **Step 6: Run the truncation regression spine**

```bash
bun test test/unit/agents/native/session/us-003-acs.test.ts test/unit/agents/native/session/native-truncation-nudge.test.ts test/unit/agents/native/session/native-truncation-chokepoint.test.ts --timeout=30000
bun test $TURN_TESTS --timeout=30000
```

Expected: PASS **unedited**. These tests encode AC8's fail-open contract and the nudge reserve; if one fails, the migration changed behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/agents/native/session/truncation-handler.ts src/agents/native/session/loop-handlers.ts src/agents/native/session/turn-tool-batch.ts src/agents/native/session/loop-events/types.ts
git commit -m "refactor(native): truncation becomes a registered after_tool handler

The seam's canonical consumer could not be registered while the dispatcher was
synchronous — the spill write must be awaited, because AC8's fail-open contract
means the marker may only name the spill file when the write succeeded. Task 2
made dispatch async, so the documented exception is deleted rather than
restated.

AfterToolPayload gains nudgeText, toolName and callId. The nudge reserve would
otherwise be silently lost and a nudged result would exceed its budget, which
no existing assertion catches: the nudge tests assert content, not byte totals.

Registered last, so it shapes whatever earlier handlers produced — the position
the hardcoded call already had."
```

---

### Task 10: Final verification

- [ ] **Step 1: Confirm the dormant-by-default claim**

```bash
bun test $TURN_TESTS --timeout=30000
```

Expected: PASS. With no handler registered, a run must behave byte-identically to `f849ca9b7` — this is what makes the PR safe to merge with five events that nothing consumes.

- [ ] **Step 2: Confirm the file budget**

```bash
wc -l src/agents/native/session/loop-events/*.ts src/agents/native/session/turn-*.ts
bun run scripts/check-file-sizes.ts
```

Expected: every file under 600, and the **same baseline of 13** grandfathered files — not 14.

- [ ] **Step 3: Confirm no existing test was weakened**

```bash
git diff main...HEAD --stat -- test/
```

New files are expected. **Any modification to an existing test file must be justified in the PR body** — per Global Constraints, a weakened assertion in a PR whose events ship dormant is a stop condition.

- [ ] **Step 4: Full suite and gates**

```bash
bun run test
bun run typecheck
bun run lint
```

Expected: green, including `check:import-cycles` at baseline 0 — `loop-events/` importing from `../compaction` and `../tool-result` while `turn-*.ts` imports `loop-events/` is exactly where a cycle would appear.

- [ ] **Step 5: Coverage**

```bash
bun run test:coverage
```

Not part of the nax pipeline; a separate CI step with a per-file floor. New files with thin direct coverage can fail it even with a green suite. Report rather than silently updating the baseline.

- [ ] **Step 6: Open the PR**

Title: `feat(native): the full loop-event seam (P3 PR 2)`

Body must state: the six events and that five ship with **no production consumer** (spec §2.1's ruling, so it reads as intent not oversight); that defaults are dormant; the truncation migration as the one production change; the cache-boundary checker and the §6.6 wire-copy ruling; and a link to the spec. **Run a code review before pushing, never after.**

---

## Self-Review

**Spec coverage:** §3 (all seven subsections) → Tasks 3, 5, 7. §4.1 naming → Task 1. §4.2 async + rejection → Task 2. §4.3 typed map → Task 1. §4.4 fast path → Task 2 Step 2's first test. §4.5 file layout → Tasks 1-3. §4.6 lifetime → Task 2 Step 5. §4.7 invariants → Task 2 Step 4. §6.1 all six events → Tasks 4-8. §6.2 asymmetric decline → Task 6. §6.3 options bag → Task 4. §6.4 followUp bounds → Task 8. §6.5 request wrapper → Task 4. §6.6 wire copy → Task 5. §7 truncation → Task 9. §9 testing → every task's test step plus Task 10. **No gap.**

**Correctly absent:** nothing adds `model` to `TranscriptFile` or registers a `before_turn` handler for nax#2150 — that is PR 3. Task 7 builds the channel and pins that it is closed (`boundary: false`) until then, which is the honest state rather than a stub.

**Type consistency:** `HandlerOf<E>`/`PayloadOf<E>`/`PatchOf<E>` are produced in Task 1 and used by name in Tasks 2, 4, 9. `applyHistoryPatch`/`checkPrefixStable` are produced in Task 3 and consumed in Tasks 5 and 7. `CompleteCallOptions` is produced in Task 1, threaded in Task 4. `request()` is produced in Task 4 and extended in Task 5. `AfterToolPayload` gains three fields in Task 9, declared in Task 1's file. No name drifts.

**Known soft spots, flagged rather than hidden:** Task 1 Step 2's `before_tool` payload reshape is the one existing-handler signature change, called out where it happens. Task 9 Step 3 tells the implementer to check whether `AfterToolPayload` already carries `toolName`/`callId` rather than assuming. Task 4 Step 1 was a soft spot until verified: `TurnDeps` has **no** `model` field, `CompleteStepArgs` has no `roundTrip`, and `deps.loopEvents` is **not** the registry in use (`turn-loop.ts:94` falls back to a fresh one). All three are now stated as explicit threading work in Task 4 rather than left for the implementer to trip over, and Task 6 carries the same note for `CompactionStepArgs`.
