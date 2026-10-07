import { describe, expect, test } from "bun:test";
import type { AdapterInteraction, InteractionHandler } from "@nathapp/nax-agent";
import { withWarnSpy } from "@test/helpers";
import { awaitInteractionReply, toContextToolInteraction } from "@/agents/interaction/turn-interactions";

const handler = (fn: InteractionHandler["onInteraction"]): InteractionHandler => ({ onInteraction: fn });
const question: AdapterInteraction = { kind: "question", text: "Which branch?" };

describe("awaitInteractionReply", () => {
  test("answered when the handler replies", async () => {
    const reply = await awaitInteractionReply(
      { interactionHandler: handler(async () => ({ answer: "main" })), stage: "acp-adapter" },
      question,
      ": ",
    );
    expect(reply).toEqual({ kind: "answered", answer: "main" });
  });

  test("no-reply when the handler returns null", async () => {
    const reply = await awaitInteractionReply(
      { interactionHandler: handler(async () => null), stage: "acp-adapter" },
      question,
      ": ",
    );
    expect(reply).toEqual({ kind: "no-reply" });
  });

  test("no-reply when the human-reply timeout fires first", async () => {
    const reply = await awaitInteractionReply(
      { interactionHandler: handler(() => new Promise(() => {})), stage: "acp-adapter", timeoutMs: 10 },
      question,
      ": ",
    );
    expect(reply).toEqual({ kind: "no-reply" });
  });

  test("a handler failure is logged under the given stage with the suffix, then no-reply", async () => {
    await withWarnSpy(async (warnSpy) => {
      const reply = await awaitInteractionReply(
        {
          interactionHandler: handler(async () => {
            throw new Error("webhook down");
          }),
          stage: "acp-adapter",
        },
        question,
        " for context-tool: ",
      );
      expect(reply).toEqual({ kind: "no-reply" });
      expect(warnSpy.mock.calls[0]?.[0]).toBe("acp-adapter");
      expect(warnSpy.mock.calls[0]?.[1]).toBe("InteractionHandler.onInteraction failed for context-tool: webhook down");
    });
  });

  test("aborted when the signal aborts during the wait", async () => {
    const ctl = new AbortController();
    const pending = awaitInteractionReply(
      { interactionHandler: handler(() => new Promise(() => {})), signal: ctl.signal, stage: "acp-adapter" },
      question,
      ": ",
    );
    ctl.abort();
    expect(await pending).toEqual({ kind: "aborted" });
  });
});

describe("toContextToolInteraction", () => {
  test("carries the input when there is no error", () => {
    expect(toContextToolInteraction({ name: "q", input: { a: 1 } })).toEqual({
      kind: "context-tool",
      name: "q",
      input: { a: 1 },
    });
  });

  test("carries only the error when parsing failed", () => {
    expect(toContextToolInteraction({ name: "q", error: "Invalid JSON tool input: x" })).toEqual({
      kind: "context-tool",
      name: "q",
      error: "Invalid JSON tool input: x",
    });
  });
});
