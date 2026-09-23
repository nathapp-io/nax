import { describe, expect, mock, test } from "bun:test";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import type { AfterResponsePatch } from "@/agents/native/session/loop-events/types";

describe("loop event registry", () => {
  test("dispatch returns an empty patch without touching the payload when no handler is registered", async () => {
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
    registry.register("after_response", (p) => {
      seen.push(`a:${p.text}`);
      return { text: `${p.text}1` };
    });
    registry.register("after_response", (p) => {
      seen.push(`b:${p.text}`);
      return { text: `${p.text}2` };
    });
    const patch = await registry.dispatch("after_response", {
      text: "x",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      roundTrip: 1,
    });
    expect(seen).toEqual(["a:x", "b:x1"]);
    expect(patch.text).toBe("x12");
  });

  test("a THROWING handler is logged and skipped, later handlers still run", async () => {
    const registry = createLoopEventRegistry();
    registry.register("after_response", () => {
      throw new Error("boom");
    });
    registry.register("after_response", (p) => ({ text: `${p.text}!` }));
    const patch = await registry.dispatch("after_response", {
      text: "x",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      roundTrip: 1,
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
      text: "x",
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      roundTrip: 1,
    });
    expect(patch.text).toBe("x!");
  });

  test("usage and costUsd are not patchable on after_response", async () => {
    const registry = createLoopEventRegistry();
    // The mock's declared return type smuggles `usage` past AfterResponsePatch
    // — a field the patch type does not declare — which is the exact bypass
    // this test exists to defeat at runtime. (`as never` has no sanctioned
    // escape hatch here, and a bare mock's inferred return has no property in
    // common with the all-optional patch type, so the intersection annotation
    // is how the smuggled field is typed.)
    registry.register(
      "after_response",
      mock((): AfterResponsePatch & { usage?: { inputTokens: number; outputTokens: number } } => ({
        usage: { inputTokens: 999, outputTokens: 999 },
      })),
    );
    const patch = await registry.dispatch("after_response", {
      text: "x",
      usage: { inputTokens: 1, outputTokens: 2 },
      costUsd: 3,
      roundTrip: 1,
    });
    expect((patch as { usage?: unknown }).usage).toBeUndefined();
  });
});
