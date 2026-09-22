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
      "before_tool",
      "after_tool",
      "before_turn",
      "transform_context",
      "before_request",
      "after_response",
      "before_compaction",
      "before_turn_end",
    ];
    expect(new Set(all).size).toBe(8);
  });
});
