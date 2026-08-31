// test/protocols/collect.test.ts
import { describe, expect, it } from "vitest";
import { collectStream } from "../../src/protocols/collect.ts";
import type { ProtocolEvent } from "../../src/protocols/types.ts";

async function* emit(...events: ProtocolEvent[]): AsyncIterable<ProtocolEvent> {
  for (const event of events) yield event;
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("collectStream", () => {
  it("concatenates text deltas in order", async () => {
    const result = await collectStream(
      emit(
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        { type: "usage", usage },
        { type: "done", stopReason: "stop" },
      ),
    );
    expect(result.text).toBe("Hello");
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toEqual(usage);
  });

  it("collects completed tool calls and ignores partials", async () => {
    const call = { id: "t1", name: "read", input: { path: "a.ts" } };
    const result = await collectStream(
      emit(
        { type: "tool-call-partial", id: "t1", name: "read", rawInput: '{"pa' },
        { type: "tool-call", call },
        { type: "usage", usage },
        { type: "done", stopReason: "tool_use" },
      ),
    );
    expect(result.toolCalls).toEqual([call]);
  });

  it("rejects on an error event", async () => {
    // The one inversion of the events-not-exceptions rule: a caller awaiting a
    // single result has nowhere to put a partial one.
    await expect(
      collectStream(
        emit(
          { type: "text-delta", text: "partial" },
          { type: "error", error: { kind: "overloaded", message: "busy" } },
        ),
      ),
    ).rejects.toThrow(/busy/);
  });

  it("throws when the stream ends without a done event", async () => {
    // A truncated stream must not look like a clean short answer.
    await expect(collectStream(emit({ type: "text-delta", text: "x" }))).rejects.toThrow(/without a done event/i);
  });

  it("reports zeroed usage when the provider sent none", async () => {
    const result = await collectStream(emit({ type: "done", stopReason: "stop" }));
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("ignores thinking deltas in the collected text", async () => {
    const result = await collectStream(
      emit(
        { type: "thinking-delta", text: "hmm" },
        { type: "text-delta", text: "answer" },
        { type: "done", stopReason: "stop" },
      ),
    );
    expect(result.text).toBe("answer");
  });
});
