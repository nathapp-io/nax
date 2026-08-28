/**
 * `maybeHandleRecurrenceBreaker` — #1666 Part C consumption seam.
 *
 * Covers the "check the breaker, notify, pause" sequence split out of
 * `post-run.ts` into its own file. Mirrors the inline oscillation-breaker
 * handling in intent, but this seam is a standalone function so it gets its
 * own direct tests rather than only being exercised through `decideStageAction`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTestContext, makeTestRuntime, makeTestStory } from "@test/helpers";
import { maybeHandleRecurrenceBreaker, type ReviewRecurrenceStore, recordReviewFindings } from "@/execution";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "@/interaction";
import { InteractionChain } from "@/interaction";
import { getLogger, initLogger, type Logger, resetLogger } from "@/logger";
import type { PipelineContext } from "@/pipeline/types";

let logger: Logger;
beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent" });
  logger = getLogger();
});
afterEach(() => {
  resetLogger();
});

function seedTrippedStore(storyId: string, source: "semantic-review" | "adversarial-review"): ReviewRecurrenceStore {
  const store: ReviewRecurrenceStore = new Map();
  const finding = { source, severity: "error" as const, category: "test", message: "m", rule: "R1", file: "f.ts" };
  // Default threshold is 2 — three sightings of the same finding gives maxRecurrences=2.
  recordReviewFindings(store, storyId, source, [finding]);
  recordReviewFindings(store, storyId, source, [finding]);
  recordReviewFindings(store, storyId, source, [finding]);
  return store;
}

function makeCtx(opts: {
  store?: ReviewRecurrenceStore;
  storyId?: string;
  withInteraction?: InteractionChain;
}): PipelineContext {
  const storyId = opts.storyId ?? "US-pause-1";
  const ctx = makeTestContext({
    story: makeTestStory({ id: storyId, title: "Recurrence pause unit" }),
  });
  ctx.config = {
    ...ctx.config,
    review: {
      ...ctx.config.review,
      conflictDetection: { enabled: true, maxOscillations: 2, maxCrossAttemptRecurrences: 2 },
    },
  } as typeof ctx.config;

  const runtime = makeTestRuntime();
  Object.defineProperty(runtime, "reviewFindingRecurrences", {
    value: opts.store ?? new Map(),
    configurable: true,
  });
  Object.defineProperty(ctx, "runtime", { value: runtime, configurable: true });

  if (opts.withInteraction) {
    ctx.interaction = opts.withInteraction;
  }

  return ctx;
}

describe("maybeHandleRecurrenceBreaker — no trip", () => {
  test("returns undefined when the breaker does not trip", async () => {
    const ctx = makeCtx({ store: new Map() });
    const result = await maybeHandleRecurrenceBreaker(ctx, logger);
    expect(result).toBeUndefined();
  });
});

describe("maybeHandleRecurrenceBreaker — trip, no interaction configured", () => {
  test("returns a pause StageResult carrying the breaker's reason", async () => {
    const store = seedTrippedStore("US-pause-2", "semantic-review");
    const ctx = makeCtx({ store, storyId: "US-pause-2" });
    const result = await maybeHandleRecurrenceBreaker(ctx, logger);
    expect(result).toEqual({ action: "pause", reason: expect.stringContaining("deadlock") });
  });
});

describe("maybeHandleRecurrenceBreaker — trip, interaction present", () => {
  test("sends a notify request through the interaction chain and still returns pause", async () => {
    const sentRequests: InteractionRequest[] = [];
    const fakePlugin: InteractionPlugin = {
      name: "fake",
      send: async (request: InteractionRequest) => {
        sentRequests.push(request);
      },
      receive: async (requestId: string): Promise<InteractionResponse> => ({
        requestId,
        action: "reject",
        respondedBy: "test",
        respondedAt: Date.now(),
      }),
    };
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "continue" });
    interactionChain.register(fakePlugin, 0);

    const store = seedTrippedStore("US-pause-3", "adversarial-review");
    const ctx = makeCtx({ store, storyId: "US-pause-3", withInteraction: interactionChain });

    const result = await maybeHandleRecurrenceBreaker(ctx, logger);

    expect(result?.action).toBe("pause");
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]?.type).toBe("notify");
    expect(sentRequests[0]?.storyId).toBe("US-pause-3");
    expect(sentRequests[0]?.detail).toContain("Recurrence pause unit");
  });

  test("a rejecting interaction.send is caught — still returns pause, does not throw", async () => {
    const failingPlugin: InteractionPlugin = {
      name: "failing",
      send: async () => {
        throw new Error("notification channel unreachable");
      },
      receive: async (requestId: string): Promise<InteractionResponse> => ({
        requestId,
        action: "reject",
        respondedBy: "test",
        respondedAt: Date.now(),
      }),
    };
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "continue" });
    interactionChain.register(failingPlugin, 0);

    const store = seedTrippedStore("US-pause-4", "semantic-review");
    const ctx = makeCtx({ store, storyId: "US-pause-4", withInteraction: interactionChain });

    let result: Awaited<ReturnType<typeof maybeHandleRecurrenceBreaker>> | undefined;
    let thrown: unknown;
    try {
      result = await maybeHandleRecurrenceBreaker(ctx, logger);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result).toEqual({ action: "pause", reason: expect.stringContaining("deadlock") });
  });
});
