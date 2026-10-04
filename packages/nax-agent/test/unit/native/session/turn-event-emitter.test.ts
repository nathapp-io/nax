/**
 * S3-3: the per-turn emitter is the only caller of an embedder's onTurnEvent
 * sink. It contains a throwing or rejecting sink, redacts tool input, and
 * caps and redacts the tool-result preview. Without a sink it does nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { buildToolResult } from "#src/native/session/tool-result";
import {
  createTurnEventEmitter,
  TOOL_CALL_INPUT_BYTES,
  TOOL_RESULT_PREVIEW_BYTES,
  usageEvent,
} from "#src/native/session/turn-event-emitter";
import type { TurnEvent, TurnEventSink } from "#src/session/turn-event";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";

function collector(): { events: TurnEvent[]; sink: TurnEventSink } {
  const events: TurnEvent[] = [];
  return { events, sink: (event) => void events.push(event) };
}

const readCall = (id: string, input: unknown = { path: "a.ts" }) => ({ id, name: "Read", input });

describe("createTurnEventEmitter", () => {
  test("forwards events to the sink in order", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.emit({ type: "compaction", reason: "proactive" });
    emitter.emit({ type: "stream_reset", round: 1, attempt: 2 });
    expect(events).toEqual([
      { type: "compaction", reason: "proactive" },
      { type: "stream_reset", round: 1, attempt: 2 },
    ]);
  });

  test("deltaSink stamps the round on each delta", () => {
    const { events, sink } = collector();
    const onDelta = createTurnEventEmitter(sink).deltaSink(3);
    if (onDelta === undefined) throw new Error("expected a delta sink when a sink is set");
    onDelta({ type: "text_delta", text: "he" });
    onDelta({ type: "thinking_delta", text: "hm" });
    expect(events).toEqual([
      { type: "text_delta", round: 3, text: "he" },
      { type: "thinking_delta", round: 3, text: "hm" },
    ]);
  });

  test("without a sink: no delta sink, and every method is a no-op", () => {
    const emitter = createTurnEventEmitter(undefined);
    expect(emitter.deltaSink(1)).toBeUndefined();
    expect(() => {
      emitter.emit({ type: "compaction", reason: "overflow" });
      emitter.toolCall(readCall("c1"), undefined);
      emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "x" }));
      emitter.flushUnanswered();
    }).not.toThrow();
  });

  test("a throwing sink is contained and still receives the next event", () => {
    let calls = 0;
    const emitter = createTurnEventEmitter(() => {
      calls += 1;
      throw new Error("sink exploded");
    });
    emitter.emit({ type: "compaction", reason: "proactive" });
    emitter.emit({ type: "compaction", reason: "overflow" });
    expect(calls).toBe(2);
  });

  describe("an async sink that rejects", () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => void seen.push(reason);
    afterEach(() => {
      process.off("unhandledRejection", onUnhandled);
      seen.length = 0;
    });

    test("never surfaces an unhandled rejection", async () => {
      process.on("unhandledRejection", onUnhandled);
      const asyncSink: TurnEventSink = async () => {
        throw new Error("async sink exploded");
      };
      createTurnEventEmitter(asyncSink).emit({ type: "compaction", reason: "proactive" });
      createTurnEventEmitter(asyncSink).emit({ type: "compaction", reason: "overflow" });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual([]);
    });
  });

  test("toolCall reports the recorded input when given, else the model's, redacted", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1", { path: "model.ts" }), { path: "rewritten.ts" });
    emitter.toolCall(readCall("c2", { command: `curl -H "x: ${SECRET}"`, apiKey: "plain" }), undefined);
    expect(events[0]).toEqual({ type: "tool_call", callId: "c1", name: "Read", input: { path: "rewritten.ts" } });
    const second = events[1];
    if (second?.type !== "tool_call") throw new Error("expected a tool_call");
    expect(JSON.stringify(second.input)).not.toContain(SECRET);
    expect(second.input).toHaveProperty("apiKey", "[REDACTED]");
  });

  test("a repeated call id is answered once per call", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("dup"), undefined);
    emitter.toolCall(readCall("dup"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "dup", content: "one" }));
    emitter.toolResult(buildToolResult({ toolCallId: "dup", content: "two" }));
    emitter.toolResult(buildToolResult({ toolCallId: "dup", content: "three" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
  });

  test("flushUnanswered answers every outstanding call with an error result, then nothing", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolCall(readCall("c2"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "ok" }));
    emitter.flushUnanswered();
    emitter.flushUnanswered();
    expect(events.slice(3)).toEqual([
      { type: "tool_result", callId: "c2", isError: true, preview: "Not answered: the turn ended." },
    ]);
  });

  test("a tool_call input over the byte cap is replaced by a truncated JSON preview", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall({ id: "w1", name: "Write", input: { path: "big.txt", content: "x".repeat(50_000) } }, undefined);
    const event = events[0];
    if (event?.type !== "tool_call") throw new Error("expected a tool_call");
    expect(event.input).toHaveProperty("truncated", true);
    const preview = (event.input as { preview?: unknown }).preview;
    expect(typeof preview).toBe("string");
    expect(Buffer.byteLength(String(preview), "utf8")).toBeLessThanOrEqual(TOOL_CALL_INPUT_BYTES);
  });

  test("known gap (best-effort redaction): a JSON credential file's text is not masked", () => {
    // Pinned so widening SECRET_VALUE_PATTERNS later is a deliberate, visible change.
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: '{"client_secret": "plainvalue123"}' }));
    expect(events[1]).toHaveProperty("preview", '{"client_secret": "plainvalue123"}');
  });

  test("redaction scans a bounded prefix of a very large result", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: `${SECRET} ${"y".repeat(2_000_000)}` }));
    const result = events[1];
    if (result?.type !== "tool_result") throw new Error("expected a tool_result");
    expect(result.preview).not.toContain(SECRET);
    expect(Buffer.byteLength(result.preview, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_BYTES);
  });

  test("toolResult reports only a call toolCall reported, and only once", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolResult(buildToolResult({ toolCallId: "never-called", content: "x" }));
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "body" }));
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "body again" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect(events[1]).toEqual({ type: "tool_result", callId: "c1", isError: false, preview: "body" });
  });

  test("an input whose redaction throws leaves no outstanding call for toolResult", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    const hostile = {
      get path(): string {
        throw new Error("input getter blew up");
      },
    };
    expect(() => emitter.toolCall(readCall("c1", hostile), undefined)).toThrow();
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "failed" }));
    expect(events).toEqual([]);
  });

  test("isError mirrors the result; a denial is not an error", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "boom", isError: true }));
    emitter.toolCall(readCall("c2"), undefined);
    emitter.toolResult(
      buildToolResult({ toolCallId: "c2", content: "refused", denied: { reason: "outside root", breach: false } }),
    );
    expect(events.filter((e) => e.type === "tool_result")).toEqual([
      { type: "tool_result", callId: "c1", isError: true, preview: "boom" },
      { type: "tool_result", callId: "c2", isError: false, preview: "refused" },
    ]);
  });

  test("the preview is redacted, then cut to the byte cap on a codepoint boundary", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    // A secret up front, then 3-byte characters well past the cap.
    const content = `token ${SECRET} ${"\u20ac".repeat(3000)}`;
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content }));
    const result = events[1];
    if (result?.type !== "tool_result") throw new Error("expected a tool_result");
    expect(result.preview).not.toContain(SECRET);
    expect(Buffer.byteLength(result.preview, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_BYTES);
    expect(result.preview).not.toContain("\uFFFD");
    expect(result.preview.length).toBeGreaterThan(1000);
  });
});

describe("usageEvent", () => {
  test("carries the round and cost; cache fields absent stay absent, zero stays zero", () => {
    expect(usageEvent(2, { inputTokens: 10, outputTokens: 5 }, 0.5)).toEqual({
      type: "usage",
      round: 2,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
    });
    expect(usageEvent(1, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 7 }, 0)).toEqual({
      type: "usage",
      round: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 7,
      costUsd: 0,
    });
  });
});
