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

  test("forwards the turn context into callTool", async () => {
    const seen: Array<{ name: string; input: Record<string, unknown>; context?: unknown }> = [];
    const runtime: CodingToolRuntime = {
      advertised: () => [],
      callTool: async (name, input, context) => {
        seen.push({ name, input, context });
        return { kind: "ok", content: "ok" };
      },
    };
    const handler = buildRunInteractionHandler({ codingToolRuntime: runtime });
    await handler.onInteraction({
      kind: "coding-tool",
      name: "Read",
      input: { path: "a.ts" },
      turnId: "turn-1",
      roundTrips: 2,
      toolCallId: "toolu_x",
    });
    expect(seen[0]?.context).toEqual({ turnId: "turn-1", roundTrips: 2, toolCallId: "toolu_x" });
  });

  // US-002 AC14: the native batch sends the single per-turn signal and an
  // onWaiting callback on every coding-tool request; buildRunInteractionHandler
  // must forward both into the ToolCallContext it hands the runtime, so a tool
  // can stop in-flight work (Bash/Exec SIGKILL) when the turn is cancelled.
  test("US-002 AC14: forwards the coding-tool signal into callTool's ToolCallContext", async () => {
    const seen: Array<{ signal?: AbortSignal }> = [];
    const runtime: CodingToolRuntime = {
      advertised: () => [],
      callTool: async (_name, _input, context) => {
        if (context?.signal !== undefined) seen.push({ signal: context.signal });
        return { kind: "ok", content: "ok" };
      },
    };
    const handler = buildRunInteractionHandler({ codingToolRuntime: runtime });
    const signal = new AbortController().signal;
    await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" }, signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBe(signal);
  });

  test("US-002 AC14: forwards onWaiting into callTool's ToolCallContext", async () => {
    const seen: Array<{ onWaiting?: () => void }> = [];
    const runtime: CodingToolRuntime = {
      advertised: () => [],
      callTool: async (_name, _input, context) => {
        if (context?.onWaiting !== undefined) seen.push({ onWaiting: context.onWaiting });
        return { kind: "ok", content: "ok" };
      },
    };
    const handler = buildRunInteractionHandler({ codingToolRuntime: runtime });
    const onWaiting = () => {};
    await handler.onInteraction({ kind: "coding-tool", name: "Read", input: { path: "a.ts" }, onWaiting });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.onWaiting).toBe(onWaiting);
  });
});
