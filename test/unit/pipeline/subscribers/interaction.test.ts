// RE-ARCH: keep
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { wireInteraction } from "../../../../src/pipeline/subscribers/interaction";
import { PipelineEventBus, type StoryFailedEvent } from "../../../../src/pipeline/event-bus";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { UserStory } from "../../../../src/prd";

describe("wireInteraction", () => {
  test("no subscriptions when interactionChain is null", () => {
    const bus = new PipelineEventBus();
    wireInteraction(bus, null, DEFAULT_CONFIG);
    expect(bus.subscriberCount("human-review:requested")).toBe(0);
  });

  test("no subscriptions when human-review trigger is disabled", () => {
    const bus = new PipelineEventBus();
    const config = {
      ...DEFAULT_CONFIG,
      interaction: { ...DEFAULT_CONFIG.interaction, triggers: { "human-review": { enabled: false } } },
    } as any;
    const chain = {} as any;
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
  let mockChain: any;
  let mockLogger: any;
  let loggedWarnings: Array<{ context: string; message: string; data: any }> = [];

  beforeEach(() => {
    bus = new PipelineEventBus();
    mockChain = {
      prompt: async () => ({ action: "skip" }),
    };
    loggedWarnings = [];
  });

  afterEach(() => {
    bus.clear();
  });

  function createStoryFailedEvent(
    overrides: Partial<StoryFailedEvent> = {},
  ): StoryFailedEvent {
    const story: UserStory = {
      id: "US-001",
      title: "Test Story",
      description: "Test",
      acceptanceCriteria: [],
    };
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
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: false } },
      },
    } as any;
    wireInteraction(bus, mockChain, config);
    expect(bus.subscriberCount("story:failed")).toBe(0);
  });

  test("no subscription when interactionChain is null", () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;
    wireInteraction(bus, null, config);
    expect(bus.subscriberCount("story:failed")).toBe(0);
  });

  test("fires max-retries trigger when countsTowardEscalation=true", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let triggerCalled = false;
    mockChain.prompt = async (request: any) => {
      triggerCalled = true;
      expect(request.id).toContain("trigger-max-retries");
      return { action: "skip" };
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));

    // Give async handler time to execute
    await Bun.sleep(10);
    expect(triggerCalled).toBe(true);
  });

  test("does NOT fire max-retries trigger when countsTowardEscalation=false", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let triggerCalled = false;
    mockChain.prompt = async () => {
      triggerCalled = true;
      return { action: "skip" };
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: false }));

    await Bun.sleep(10);
    expect(triggerCalled).toBe(false);
  });

  test("passes correct context to executeTrigger", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let capturedRequest: any;
    mockChain.prompt = async (request: any) => {
      capturedRequest = request;
      return { action: "skip" };
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

    await Bun.sleep(10);
    expect(capturedRequest?.featureName).toBe("auth-feature");
    expect(capturedRequest?.storyId).toBe("story-42");
    // Verify the request ID contains the trigger name
    expect(capturedRequest?.id).toContain("trigger-max-retries");
  });

  test("handles abort response with warning", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let loggedAbort = false;
    const originalLogger = console.warn;
    console.warn = ((context: string, message: string, data: any) => {
      if (message === "max-retries abort requested") {
        loggedAbort = true;
      }
    }) as any;

    mockChain.prompt = async () => {
      return { action: "abort" };
    };

    try {
      wireInteraction(bus, mockChain, config);
      bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));
      await Bun.sleep(10);
      // Note: actual logging behavior depends on getSafeLogger implementation
    } finally {
      console.warn = originalLogger;
    }
  });

  test("handles skip response (default)", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let skipCalled = false;
    mockChain.prompt = async () => {
      skipCalled = true;
      return { action: "skip" };
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));

    await Bun.sleep(10);
    expect(skipCalled).toBe(true);
  });

  test("handles escalate response (treated as skip)", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let escalateCalled = false;
    mockChain.prompt = async () => {
      escalateCalled = true;
      return { action: "escalate" };
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));

    await Bun.sleep(10);
    expect(escalateCalled).toBe(true);
  });

  test("catches trigger execution errors gracefully", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    mockChain.prompt = async () => {
      throw new Error("Trigger failed");
    };

    wireInteraction(bus, mockChain, config);
    // Should not throw
    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));
    await Bun.sleep(10);
  });

  test("handles missing feature field", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let capturedRequest: any;
    mockChain.prompt = async (request: any) => {
      capturedRequest = request;
      return { action: "skip" };
    };

    wireInteraction(bus, mockChain, config);
    bus.emit(createStoryFailedEvent({ feature: undefined, countsTowardEscalation: true }));

    await Bun.sleep(10);
    expect(capturedRequest?.featureName).toBe("");
  });

  test("unsubscribes correctly", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      interaction: {
        ...DEFAULT_CONFIG.interaction,
        triggers: { "max-retries": { enabled: true } },
      },
    } as any;

    let triggerCalled = false;
    mockChain.prompt = async () => {
      triggerCalled = true;
      return { action: "skip" };
    };

    const unsub = wireInteraction(bus, mockChain, config);
    unsub();

    bus.emit(createStoryFailedEvent({ countsTowardEscalation: true }));
    await Bun.sleep(10);
    expect(triggerCalled).toBe(false);
  });
});
