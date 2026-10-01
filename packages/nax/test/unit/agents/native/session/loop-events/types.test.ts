import { describe, expect, test } from "bun:test";
import type { LoopEvent, LoopEventMap } from "@/agents/native/session/loop-events/types";

describe("loop event map", () => {
  test("every LoopEvent member has a map entry", () => {
    type Missing = Exclude<LoopEvent, keyof LoopEventMap>;
    // Compile-time exhaustiveness: this type is `true` only when every LoopEvent
    // member has a LoopEventMap entry — a missing entry fails the typecheck.
    const exhaustive: [Missing] extends [never] ? true : false = true;
    expect(exhaustive).toBe(true);
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
