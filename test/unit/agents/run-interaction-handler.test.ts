import { describe, expect, test } from "bun:test";
import { buildRunInteractionHandler, type RunInteractionOptions } from "@/agents/run-interaction-handler";
import type { CodingToolOutcome, CodingToolRuntime } from "@/tools";

// No casts: the handler takes a NARROWED option type (see Step 4), so a test can
// construct one honestly. `check:test-as-unknown-as` sits at baseline 0.
function runtimeReturning(outcome: CodingToolOutcome): CodingToolRuntime {
  return {
    advertised: () => [],
    callTool: async () => outcome,
  };
}

function optionsWith(runtime: CodingToolRuntime): RunInteractionOptions {
  return { codingToolRuntime: runtime };
}

describe("buildRunInteractionHandler — coding tools", () => {
  test("returns tool output on success", async () => {
    const handler = buildRunInteractionHandler(optionsWith(runtimeReturning({ kind: "ok", content: "file body" })));
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" } });
    expect(res?.answer).toContain("file body");
    expect(res?.denied).toBeUndefined();
  });

  test("an error carries no denial marker", async () => {
    const handler = buildRunInteractionHandler(optionsWith(runtimeReturning({ kind: "error", content: "ENOENT" })));
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} });
    expect(res?.answer).toContain("ENOENT");
    expect(res?.denied).toBeUndefined();
  });

  // The whole point of the separate channel: a refusal must not look like a crash.
  test("a denial is marked structurally, not merely worded", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "denied", reason: "not granted", breach: false })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Write", input: {} });
    expect(res?.denied).toEqual({ reason: "not granted", breach: false });
  });

  test("a breach denial carries the breach flag through", async () => {
    const handler = buildRunInteractionHandler(
      optionsWith(runtimeReturning({ kind: "denied", reason: "outside root", breach: true })),
    );
    const res = await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} });
    expect(res?.denied?.breach).toBe(true);
  });

  test("returns null when no coding runtime is configured", async () => {
    const handler = buildRunInteractionHandler({});
    expect(await handler.onInteraction({ kind: "coding-tool", name: "Read", input: {} })).toBeNull();
  });
});
