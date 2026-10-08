// test/unit/agents/acp/turn-slot.test.ts
import { describe, expect, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "@nathapp/nax-agent";
import { startCall } from "@/agents/acp/stream-bridge";
import { createTurnSlot } from "@/agents/acp/turn-slot";

describe("createTurnSlot", () => {
  test("between turns: no turn, an unaborted signal, no turn id", () => {
    const slot = createTurnSlot();
    expect(slot.current()).toBeUndefined();
    expect(slot.signal().aborted).toBe(false);
    expect(slot.turnId()).toBeUndefined();
  });

  test("a running turn's signal and id are read through the slot until cleared", () => {
    const slot = createTurnSlot();
    const controller = new AbortController();
    slot.set({
      signal: controller.signal,
      turnId: "turn-1",
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      call: startCall({
        emit: undefined,
        agentName: "claude",
        sessionName: "s",
        runId: "",
        storyId: undefined,
        model: "sonnet",
        timeoutSeconds: 1,
        pid: () => undefined,
      }),
      consumeInteraction: () => true,
      recordExchange: () => {},
    });
    expect(slot.signal()).toBe(controller.signal);
    expect(slot.turnId()).toBe("turn-1");
    slot.clear();
    expect(slot.current()).toBeUndefined();
    expect(slot.signal()).not.toBe(controller.signal);
  });
});
