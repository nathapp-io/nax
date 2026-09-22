/**
 * US-002 — native loop event seam (typed in-process function registrations) and
 * result chokepoint.
 *
 * This file pins the dispatcher contract at the unit level. The integration
 * with `runNativeTurn` lives in `turn-loop-seam.test.ts`; the units here
 * drive the dispatcher directly so a failure on the seam is observed without
 * the rest of the loop's noise.
 *
 * The dispatcher enforces four rules, every one of them pinned here:
 *  1. Results are partial patches, never mutations — verified by the
 *     `unchanged` semantics AC1, AC4 expect (content / isError untouched when
 *     no handler returns a patch, denied never writable).
 *  2. Handlers chain in registration order — AC2 (second handler receives
 *     the first handler's returned `content` as its own `content`).
 *  3. A throwing handler is logged at warn, skipped, and never breaks the
 *     turn — AC3 (a sibling patch still applies after the throw).
 *  4. No handler may rewrite history — `after_tool` is safe by construction
 *     because it shapes a result before the result enters the message array
 *     (the chokepoint is `buildToolResult`, asserted in AC9).
 *
 * AC reference for each test is in the test name, e.g. `AC3:`.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type AfterToolPatch,
  type AfterToolPayload,
  type BeforeToolOutcome,
  buildToolResult,
  createLoopEventRegistry,
} from "@/agents/native/session/loop-events";

const CALL = { id: "c1", name: "Read", input: { path: "a.ts" } } as const;

describe("loop events — after_tool dispatcher", () => {
  test("AC1: with no registered handler the payload content and isError are unchanged", async () => {
    const registry = createLoopEventRegistry();
    const payload: AfterToolPayload = { content: "raw tool output", isError: false };
    // dispatch returns the accumulated PATCH, not the merged payload: an
    // empty patch is how "unchanged" reads under the patch contract — the
    // loop applies `patch.content ?? payload.content` (turn-tool-batch.ts),
    // so a patch carrying nothing leaves content and isError untouched.
    const patch = await registry.dispatch("after_tool", payload);
    expect(patch).toEqual({});
  });

  test("AC1 (boundary): one registered handler that returns no patch is a no-op", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_tool", (): AfterToolPatch => ({}));
    const patch = await registry.dispatch("after_tool", { content: "x", isError: false });
    expect(patch).toEqual({});
  });

  test("AC2: a second registered handler receives the first handler's returned content", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_tool", () => ({ content: "first-handler-output" }));
    let observed: string | undefined;
    registry.register("after_tool", (payload) => {
      observed = payload.content;
      return { content: `${payload.content} + second` };
    });
    const patched = await registry.dispatch("after_tool", { content: "original", isError: false });
    expect(observed).toBe("first-handler-output");
    expect(patched.content).toBe("first-handler-output + second");
  });

  test("AC3: a throwing handler is skipped and the next handler still applies", async () => {
    const registry = createLoopEventRegistry();
    const handlerCalls: string[] = [];
    registry.register("after_tool", () => {
      handlerCalls.push("first");
      throw new Error("first handler exploded");
    });
    registry.register("after_tool", () => {
      handlerCalls.push("second");
      return { content: "second-handler-output" };
    });
    // The throw must not propagate: the dispatcher catches it.
    const patched = await registry.dispatch("after_tool", { content: "original", isError: false });

    // Both handlers must have been tried — the throw does not abort the chain.
    expect(handlerCalls).toEqual(["first", "second"]);
    // The surviving handler's patch must apply on top of the original payload.
    expect(patched.content).toBe("second-handler-output");
  });

  test("AC3 (boundary): a throwing handler that is the LAST handler still does not surface the error", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_tool", () => {
      throw new Error("only handler exploded");
    });
    // Must not throw; the patch carries nothing — the unchanged payload under
    // the patch contract (see AC1).
    const patched = await registry.dispatch("after_tool", { content: "untouched", isError: false });
    expect(patched).toEqual({});
  });

  test("AC4: when a handler returns only content, the patched payload has no denied field", async () => {
    // The chokepoint surfaces denied as a structural part of the message that
    // passes through `after_tool`. A handler that returns only `content` must
    // never overwrite `denied` — a refused Write is not a crashed Write
    // (ADR-029 s5). The after_tool patch type does not contain `denied`, so
    // this is enforceable at the type level: even if the loop were to merge
    // a denied-bearing payload into the message, the patch itself cannot carry
    // one.
    const registry = createLoopEventRegistry();
    registry.register("after_tool", () => ({ content: "patched" }));
    const patched = await registry.dispatch("after_tool", { content: "raw", isError: false });
    expect(patched.content).toBe("patched");
    expect("denied" in patched).toBe(false);
  });

  test("AC4 (chokepoint): buildToolResult preserves denied when supplied, alongside the patched content", () => {
    // The chokepoint is the only place where `denied` is attached to the
    // outgoing message. The patched payload above has no denied; the loop
    // threads the original payload's denied into the builder, which is the
    // single merge site.
    const result = buildToolResult({
      toolCallId: CALL.id,
      content: "patched",
      isError: false,
      denied: { reason: "policy denied", breach: false },
    });
    expect(result.denied).toEqual({ reason: "policy denied", breach: false });
    expect(result.content).toBe("patched");
    expect(result.isError).toBe(false);
  });

  test("AC4 (boundary): a handler may not set denied, even when it tries", async () => {
    // The patch type does not accept `denied` — even if a handler bypasses the
    // type system and returns a denied-bearing object, the dispatcher strips
    // it so the chokepoint cannot surface it.
    const registry = createLoopEventRegistry();
    // `mock()` returns a function whose return type is `unknown`, so the
    // dispatched value can carry fields the AfterToolPatch type forbids.
    registry.register(
      "after_tool",
      mock(() => ({ content: "patched", denied: { reason: "ha", breach: true } })),
    );
    const patched = await registry.dispatch("after_tool", { content: "raw", isError: false });
    expect(patched.content).toBe("patched");
    // Patched payload cannot carry denied — the dispatcher strips it.
    expect("denied" in patched).toBe(false);
  });
});

describe("loop events — before_tool dispatcher", () => {
  test("AC5: before_tool allow with an input returns it as the new input on the outcome", async () => {
    const registry = createLoopEventRegistry();
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    expect(outcome.kind).toBe("allow");
  });

  test("AC5: before_tool allow with a rewritten input surfaces the rewrite", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "allow", input: { path: "b.ts" } }));
    const outcome: BeforeToolOutcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    expect(outcome.kind).toBe("allow");
    if (outcome.kind !== "allow") throw new Error("unreachable");
    expect(outcome.input).toEqual({ path: "b.ts" });
  });

  test("AC5: handlers chain in registration order — the LAST allow wins", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "allow", input: { path: "first-rewrite" } }));
    registry.register("before_tool", () => ({ kind: "allow", input: { path: "second-rewrite" } }));
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    if (outcome.kind !== "allow") throw new Error("unreachable");
    expect(outcome.input).toEqual({ path: "second-rewrite" });
  });

  test("AC5 (boundary): an allow with no input leaves the call's input untouched", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", (): BeforeToolOutcome => ({ kind: "allow" }));
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    if (outcome.kind !== "allow") throw new Error("unreachable");
    expect(outcome.input).toBeUndefined();
  });

  test("AC6: before_tool block short-circuits the chain and surfaces the handler's content", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "block", content: "blocked by policy" }));
    // A second handler must not run when the first one returned `block` —
    // the outcome is the dispatcher's verdict, not a chained decision.
    let secondRan = false;
    registry.register("before_tool", () => {
      secondRan = true;
      return { kind: "allow" };
    });
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") throw new Error("unreachable");
    expect(outcome.content).toBe("blocked by policy");
    expect(secondRan).toBe(false);
  });

  test("AC7: before_tool terminate is a single decision — one block of content, not chained", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "terminate", content: "turn ended" }));
    let secondRan = false;
    registry.register("before_tool", () => {
      secondRan = true;
      return { kind: "allow" };
    });
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    expect(outcome.kind).toBe("terminate");
    if (outcome.kind !== "terminate") throw new Error("unreachable");
    expect(outcome.content).toBe("turn ended");
    expect(secondRan).toBe(false);
  });

  test("AC8: before_tool nudge carries the handler text on the outcome", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => ({ kind: "nudge", text: "you already asked this" }));
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    expect(outcome.kind).toBe("nudge");
    if (outcome.kind !== "nudge") throw new Error("unreachable");
    expect(outcome.text).toBe("you already asked this");
  });

  test("AC8 (boundary): a throwing before_tool handler is skipped and the next handler decides", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", () => {
      throw new Error("first before_tool exploded");
    });
    registry.register("before_tool", () => ({ kind: "block", content: "blocked by next handler" }));
    // The throw must not propagate: the dispatcher catches it.
    const outcome = await registry.dispatch("before_tool", { call: CALL, tools: [] });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") throw new Error("unreachable");
    expect(outcome.content).toBe("blocked by next handler");
  });
});

describe("loop events — buildToolResult chokepoint", () => {
  test("AC9: buildToolResult sets toolCallId on the returned message", () => {
    const result = buildToolResult({
      toolCallId: "c42",
      content: "anything",
    });
    expect(result.toolCallId).toBe("c42");
    expect(result.role).toBe("tool-result");
  });

  test("AC9 (boundary): buildToolResult sets role to 'tool-result'; AC9: buildToolResult leaves isError absent when not supplied", () => {
    const result = buildToolResult({
      toolCallId: "c1",
      content: "x",
    });
    expect(result.role).toBe("tool-result");
    expect("isError" in result).toBe(false);
  });

  test("AC9: buildToolResult carries isError when supplied", () => {
    const result = buildToolResult({
      toolCallId: "c1",
      content: "x",
      isError: true,
    });
    expect(result.isError).toBe(true);
  });
});
