// test/unit/agents/acp-sdk/ask-port.test.ts
import { describe, expect, test } from "bun:test";
import type { AdapterInteraction, InteractionHandler } from "@nathapp/nax-agent";
import { waitForCondition } from "@test/helpers";
import { createAskPort } from "@/agents/acp-sdk/ask-port";
import type { CallBridge } from "@/agents/acp-sdk/stream-bridge";
import { createTurnSlot, type RunningTurn, type TurnSlot } from "@/agents/acp-sdk/turn-slot";

interface Harness {
  readonly slot: TurnSlot;
  readonly beats: () => number;
  readonly exchanges: Array<{ question: string; reply: string }>;
  readonly controller: AbortController;
}

function harness(handler: InteractionHandler, budget = 5): Harness {
  const slot = createTurnSlot();
  let beats = 0;
  let left = budget;
  const exchanges: Array<{ question: string; reply: string }> = [];
  const controller = new AbortController();
  const call: CallBridge = {
    callId: "c1",
    sink: () => {},
    sideEffects: () => false,
    anyEvent: () => false,
    awaitingHuman: () => {
      beats++;
    },
    end: () => {},
  };
  const turn: RunningTurn = {
    signal: controller.signal,
    turnId: "t1",
    interactionHandler: handler,
    call,
    consumeInteraction: () => {
      if (left === 0) return false;
      left--;
      return true;
    },
    recordExchange: (question, reply) => exchanges.push({ question, reply }),
  };
  slot.set(turn);
  return { slot, beats: () => beats, exchanges, controller };
}

describe("createAskPort (S4b spec §6.3)", () => {
  test("askQuestion routes to the interaction handler as a question and records the exchange", async () => {
    const asked: AdapterInteraction[] = [];
    const h = harness({
      onInteraction: async (interaction) => {
        asked.push(interaction);
        return { answer: "blue" };
      },
    });
    const reply = await createAskPort(h.slot).askQuestion("Which colour?");
    expect(reply).toBe("blue");
    expect(asked).toEqual([{ kind: "question", text: "Which colour?" }]);
    expect(h.exchanges).toEqual([{ question: "Which colour?", reply: "blue" }]);
  });

  test("no running turn, or a spent budget, answers null without asking", async () => {
    let asked = 0;
    const handler: InteractionHandler = {
      onInteraction: async () => {
        asked++;
        return { answer: "x" };
      },
    };
    expect(await createAskPort(createTurnSlot()).askQuestion("q?")).toBeNull();
    expect(await createAskPort(harness(handler, 0).slot).askQuestion("q?")).toBeNull();
    expect(asked).toBe(0);
  });

  test("a handler with no reply, or a throwing handler, answers null", async () => {
    expect(await createAskPort(harness({ onInteraction: async () => null }).slot).askQuestion("q?")).toBeNull();
    const throwing = harness({
      onInteraction: async () => {
        throw new Error("webhook down");
      },
    });
    expect(await createAskPort(throwing.slot).askQuestion("q?")).toBeNull();
  });

  test("the awaiting-human beat runs while waiting and stops when the reply settles (Review Focus 4)", async () => {
    let release: (answer: string) => void = () => {};
    const h = harness({
      onInteraction: () =>
        new Promise((resolve) => {
          release = (answer) => resolve({ answer });
        }),
    });
    const pending = createAskPort(h.slot, 10).askQuestion("q?");
    await waitForCondition(() => h.beats() >= 3);
    release("done");
    expect(await pending).toBe("done");
    const settled = h.beats();
    // Polls for a further beat; none may come once the reply settled.
    await expect(waitForCondition(() => h.beats() > settled, 60)).rejects.toThrow();
  });

  test("the turn's abort, or the caller's extra signal, ends the wait with null", async () => {
    const hang: InteractionHandler = { onInteraction: () => new Promise(() => {}) };
    const byTurn = harness(hang);
    const first = createAskPort(byTurn.slot, 1_000).askQuestion("q?");
    byTurn.controller.abort();
    expect(await first).toBeNull();
    const extra = new AbortController();
    const second = createAskPort(harness(hang).slot, 1_000).askQuestion("q?", { signal: extra.signal });
    extra.abort();
    expect(await second).toBeNull();
  });

  test("an auto-deny is written to the audit recorder (D2-k, D3-j)", () => {
    const denied: Array<[string | undefined, string, string]> = [];
    const audit = {
      onEvent: () => {},
      denied: (c: string | undefined, t: string, r: string) => denied.push([c, t, r]),
      flush: async () => {},
    };
    const port = createAskPort(createTurnSlot(), 30_000, audit);
    port.recordAutoDecision({ callId: "c1", tool: "Write", summary: "s", reason: "profile read" }, "deny");
    port.recordAutoDecision({ callId: "c2", tool: "Read", summary: "s", reason: "full" }, "allow");
    expect(denied).toEqual([["c1", "Write", "profile read"]]);
  });

  test("requestApproval denies (ask is never mapped); the other members are inert", async () => {
    const port = createAskPort(createTurnSlot());
    expect(await port.requestApproval({ tool: "Edit", summary: "edit", reason: "r" })).toEqual({
      decision: "deny",
      decidedBy: "profile",
    });
    expect(() => port.recordAutoDecision({ tool: "Edit", summary: "edit", reason: "r" }, "deny")).not.toThrow();
    expect(() => port.noteQuestion("note")).not.toThrow();
  });
});
