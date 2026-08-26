// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import {
  type InteractionAction,
  InteractionChain,
  type InteractionRequest,
  type InteractionResponse,
} from "@/interaction";
import { PipelineEventBus, type StoryFailedEvent } from "@/pipeline/event-bus";
import { wireInteraction } from "@/pipeline/subscribers/interaction";
import type { UserStory } from "@/prd";

const MOCK_CHAIN_TIMEOUT_MS = 600000;

type PromptFn = (request: InteractionRequest) => Promise<InteractionResponse>;

/** A complete InteractionResponse — the subscriber only reads `action`. */
function promptResponse(action: InteractionAction): InteractionResponse {
  return { requestId: "req-1", action, respondedAt: 0 };
}

/**
 * A real InteractionChain whose `prompt` is stubbed. `wireInteraction` reaches
 * the chain only through `executeTrigger`, which calls `chain.prompt(request)`,
 * so shadowing that one method keeps runtime behavior identical to the
 * hand-rolled `{ prompt }` bag this replaces.
 */
function makeMockChain(prompt: PromptFn): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: MOCK_CHAIN_TIMEOUT_MS, defaultFallback: "skip" });
  chain.prompt = prompt;
  return chain;
}

/**
 * Replaces `triggers` wholesale (matching the previous spread-fixture), which
 * is why this helper exists instead of `makeNaxConfig` — deepMerge would merge
 * the new trigger into the defaults rather than replacing them.
 */
function makeConfigWithTrigger(trigger: string, enabled: boolean): NaxConfig {
  const interaction = DEFAULT_CONFIG.interaction;
  if (!interaction) {
    throw new Error("DEFAULT_CONFIG.interaction must be defined");
  }
  return {
    ...DEFAULT_CONFIG,
    interaction: {
      ...interaction,
      triggers: { [trigger]: { enabled } },
    },
  };
}

describe("wireInteraction", () => {
  test("no subscriptions when interactionChain is null", () => {
    const bus = new PipelineEventBus();
    wireInteraction(bus, null, DEFAULT_CONFIG);
    expect(bus.subscriberCount("human-review:requested")).toBe(0);
  });

  test("no subscriptions when human-review trigger is disabled", () => {
    const bus = new PipelineEventBus();
    const config = makeConfigWithTrigger("human-review", false);
    const chain = makeMockChain(async () => promptResponse("skip"));
    wireInteraction(bus, chain, config);
    expect(bus.subscriberCount("human-review:requested")).toBe(0);
  });

  test("returns unsubscribe function", () => {
    const bus = new PipelineEventBus();
    const unsub = wireInteraction(bus, null, DEFAULT_CONFIG);
    expect(typeof unsub).toBe("function");
    unsub(); // should not throw
  });
});

describe("wireInteraction - max-retries trigger", () => {
  let bus: PipelineEventBus;
  let mockChain: InteractionChain;
  let loggedWarnings: Array<{ context: string; message: string; data: unknown }> = [];

  beforeEach(() => {
    bus = new PipelineEventBus();
    mockChain = makeMockChain(async () => promptResponse("skip"));
    loggedWarnings = [];
  });

  afterEach(() => {
    bus.clear();
  });

  function createStoryFailedEvent(overrides: Partial<StoryFailedEvent> = {}): StoryFailedEvent {
    const story: UserStory = makeStory({
      id: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: [],
    });
    return {
      type: "story:failed",
      storyId: "story-1",
      story,
      reason: "Test failed",
      countsTowardEscalation: true,
      feature: "test-feature",
      attempts: 3,
      ...overrides,
    };
  }

  test("no subscription when max-retries trigger is disabled", () => {
    const config = makeConfigWithTrigger("max-retries", false);
    wireInteraction(bus, mockChain, config);
    expect(bus.subscriberCount("story:failed")).toBe(0);
  });

  test("no subscription when interactionChain is null", () => {
    const config = makeConfigWithTrigger("max-retries", true);
    wireInteraction(bus, null, config);
    expect(bus.subscriberCount("story:failed")).toBe(0);
  });

  test("fires max-retries trigger when countsTowardEscalation=true", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let triggerCalled = false;
    mockChain.prompt = async (request) => {
      triggerCalled = true;
      expect(request.id).toContain("trigger-max-retries");
      return promptResponse("skip");
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));

    // Give async handler time to execute
    await Promise.resolve();
    expect(triggerCalled).toBe(true);
  });

  test("does NOT fire max-retries trigger when countsTowardEscalation=false", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let triggerCalled = false;
    mockChain.prompt = async () => {
      triggerCalled = true;
      return promptResponse("skip");
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: false }));

    await Promise.resolve();
    expect(triggerCalled).toBe(false);
  });

  test("passes correct context to executeTrigger", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let capturedRequest: InteractionRequest | undefined;
    mockChain.prompt = async (request) => {
      capturedRequest = request;
      return promptResponse("skip");
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(
      createStoryFailedEvent({
        storyId: "story-42",
        feature: "auth-feature",
        attempts: 5,
        countsTowardEscalation: true,
      }),
    );

    await Promise.resolve();
    expect(capturedRequest?.featureName).toBe("auth-feature");
    expect(capturedRequest?.storyId).toBe("story-42");
    // Verify the request ID contains the trigger name
    expect(capturedRequest?.id).toContain("trigger-max-retries");
  });

  test("handles abort response with warning", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let loggedAbort = false;
    const originalLogger = console.warn;
    console.warn = (message: string) => {
      if (message === "max-retries abort requested") {
        loggedAbort = true;
      }
    };

    mockChain.prompt = async () => {
      return promptResponse("abort");
    };

    try {
      wireInteraction(bus, mockChain, config);
      bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));
      await Promise.resolve();
      // Note: actual logging behavior depends on getSafeLogger implementation
    } finally {
      console.warn = originalLogger;
    }
  });

  test("handles skip response (default)", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let skipCalled = false;
    mockChain.prompt = async () => {
      skipCalled = true;
      return promptResponse("skip");
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));

    await Promise.resolve();
    expect(skipCalled).toBe(true);
  });

  test("handles escalate response (treated as skip)", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let escalateCalled = false;
    // An escalated interaction reaches consumers as action "approve"
    // (InteractionAction has no "escalate"; chain.applyFallback maps the
    // escalate fallback onto "approve"). The subscriber treats any non-abort
    // action identically, so the claim below is unchanged.
    mockChain.prompt = async () => {
      escalateCalled = true;
      return promptResponse("approve");
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));

    await Promise.resolve();
    expect(escalateCalled).toBe(true);
  });

  test("catches trigger execution errors gracefully", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    mockChain.prompt = async () => {
      throw new Error("Trigger failed");
    };

    wireInteraction(bus, mockChain, config);
    // Should not throw
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));
    await Promise.resolve();
  });

  test("handles missing feature field", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let capturedRequest: InteractionRequest | undefined;
    mockChain.prompt = async (request) => {
      capturedRequest = request;
      return promptResponse("skip");
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ feature: undefined, countsTowardEscalation: true }));

    await Promise.resolve();
    expect(capturedRequest?.featureName).toBe("");
  });

  test("unsubscribes correctly", async () => {
    const config = makeConfigWithTrigger("max-retries", true);

    let triggerCalled = false;
    mockChain.prompt = async () => {
      triggerCalled = true;
      return promptResponse("skip");
    };

    const unsub = wireInteraction(bus, mockChain, config);
    unsub();

    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));
    await Promise.resolve();
    expect(triggerCalled).toBe(false);
  });
});
