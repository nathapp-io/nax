/**
 * Unit tests for src/interaction/bridge-builder.ts — building an
 * `interactionBridge` from an `InteractionChain`, including question
 * detection heuristics and the timeout/error fallback.
 */

import { describe, expect, test } from "bun:test";
import { buildInteractionBridge } from "@/interaction/bridge-builder";
import { InteractionChain } from "@/interaction/chain";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "@/interaction/types";

function makeChainWithPlugin(plugin: InteractionPlugin): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "continue" });
  chain.register(plugin);
  return chain;
}

function makePlugin(overrides: Partial<InteractionPlugin> = {}): InteractionPlugin {
  return {
    name: "mock",
    send: async (_req: InteractionRequest) => {},
    receive: async (_id: string, _timeout?: number): Promise<InteractionResponse> => ({
      requestId: _id,
      action: "input",
      value: "user-answer",
      respondedBy: "user",
      respondedAt: Date.now(),
    }),
    ...overrides,
  };
}

describe("buildInteractionBridge", () => {
  test("returns undefined when chain is null", () => {
    expect(buildInteractionBridge(null, { stage: "execution" })).toBeUndefined();
  });

  test("returns undefined when chain is undefined", () => {
    expect(buildInteractionBridge(undefined, { stage: "execution" })).toBeUndefined();
  });

  test("returns undefined when the chain has no registered plugin", () => {
    const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "continue" });
    expect(buildInteractionBridge(chain, { stage: "execution" })).toBeUndefined();
  });

  test("returns a bridge object with detectQuestion and onQuestionDetected when a plugin is present", () => {
    const chain = makeChainWithPlugin(makePlugin());
    const bridge = buildInteractionBridge(chain, { stage: "execution" });
    expect(bridge).toBeDefined();
    expect(typeof bridge?.detectQuestion).toBe("function");
    expect(typeof bridge?.onQuestionDetected).toBe("function");
  });

  describe("detectQuestion", () => {
    const chain = makeChainWithPlugin(makePlugin());
    const bridge = buildInteractionBridge(chain, { stage: "execution" });

    test("matches text ending in a question mark", async () => {
      expect(await bridge?.detectQuestion("Should I proceed?")).toBe(true);
    });

    test("does not false-positive on code containing ?. or ??", async () => {
      expect(await bridge?.detectQuestion("const x = foo?.bar ?? baz;")).toBe(false);
    });

    test("matches 'which' as a whole word", async () => {
      expect(await bridge?.detectQuestion("Which approach do you prefer")).toBe(true);
    });

    test("matches 'should i'", async () => {
      expect(await bridge?.detectQuestion("should i use approach A")).toBe(true);
    });

    test("matches 'unclear'", async () => {
      expect(await bridge?.detectQuestion("The requirement is unclear here")).toBe(true);
    });

    test("matches 'please clarify'", async () => {
      expect(await bridge?.detectQuestion("please clarify the spec")).toBe(true);
    });

    test("returns false for plain declarative text", async () => {
      expect(await bridge?.detectQuestion("Implemented the feature successfully.")).toBe(false);
    });
  });

  describe("onQuestionDetected", () => {
    test("sends a request and returns the response value on success", async () => {
      let sentRequest: InteractionRequest | undefined;
      const plugin = makePlugin({
        send: async (req) => {
          sentRequest = req;
        },
        receive: async (id) => ({
          requestId: id,
          action: "input",
          value: "the-answer",
          respondedBy: "user",
          respondedAt: Date.now(),
        }),
      });
      const chain = makeChainWithPlugin(plugin);
      const bridge = buildInteractionBridge(chain, { stage: "execution", featureName: "feat-1", storyId: "US-1" }, 500);

      const answer = await bridge?.onQuestionDetected("Which way should we go?");

      expect(answer).toBe("the-answer");
      expect(sentRequest?.type).toBe("input");
      expect(sentRequest?.featureName).toBe("feat-1");
      expect(sentRequest?.storyId).toBe("US-1");
      expect(sentRequest?.stage).toBe("execution");
      expect(sentRequest?.summary).toBe("Which way should we go?");
      expect(sentRequest?.fallback).toBe("continue");
      expect(sentRequest?.id).toMatch(/^ix-execution-\d+-[a-z0-9]+$/);
    });

    test("defaults featureName to 'unknown' when not provided in context", async () => {
      let sentRequest: InteractionRequest | undefined;
      const plugin = makePlugin({
        send: async (req) => {
          sentRequest = req;
        },
      });
      const chain = makeChainWithPlugin(plugin);
      const bridge = buildInteractionBridge(chain, { stage: "pre-flight" });

      await bridge?.onQuestionDetected("A question?");

      expect(sentRequest?.featureName).toBe("unknown");
      expect(sentRequest?.storyId).toBeUndefined();
    });

    test("falls back to 'continue' when the response has no value", async () => {
      const plugin = makePlugin({
        receive: async (id) => ({ requestId: id, action: "skip", respondedBy: "user", respondedAt: Date.now() }),
      });
      const chain = makeChainWithPlugin(plugin);
      const bridge = buildInteractionBridge(chain, { stage: "execution" });

      const answer = await bridge?.onQuestionDetected("A question?");

      expect(answer).toBe("continue");
    });

    test("falls back to 'continue' when receive() throws (e.g. timeout)", async () => {
      const plugin = makePlugin({
        receive: async () => {
          throw new Error("timed out waiting for response");
        },
      });
      const chain = makeChainWithPlugin(plugin);
      const bridge = buildInteractionBridge(chain, { stage: "execution" });

      const answer = await bridge?.onQuestionDetected("A question?");

      expect(answer).toBe("continue");
    });

    test("passes the configured timeoutMs through to plugin.receive", async () => {
      let receivedTimeout: number | undefined;
      const plugin = makePlugin({
        receive: async (id, timeout) => {
          receivedTimeout = timeout;
          return { requestId: id, action: "input", value: "x", respondedBy: "user", respondedAt: Date.now() };
        },
      });
      const chain = makeChainWithPlugin(plugin);
      const bridge = buildInteractionBridge(chain, { stage: "execution" }, 42_000);

      await bridge?.onQuestionDetected("A question?");

      expect(receivedTimeout).toBe(42_000);
    });
  });
});
