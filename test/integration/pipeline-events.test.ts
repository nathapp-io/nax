/**
 * Pipeline Events Tests
 *
 * Tests for PipelineEventEmitter and event emission during pipeline execution.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PipelineEventEmitter } from "../../src/pipeline/events";
import { runPipeline } from "../../src/pipeline/runner";
import type { PipelineStage, PipelineContext, StageResult } from "../../src/pipeline/types";
import type { UserStory } from "../../src/prd/types";
import type { NaxConfig } from "../../src/config/schema";
import { initLogger, resetLogger } from "../../src/logger";

// ── Test Fixtures ────────────────────────────────────

const mockConfig: NaxConfig = {
  version: 1,
  models: {
    fast: { provider: "anthropic", model: "claude-haiku-4-5" },
    balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
    powerful: { provider: "anthropic", model: "claude-opus-4" },
  },
  autoMode: {
    enabled: true,
    defaultAgent: "claude",
    fallbackOrder: ["claude"],
    complexityRouting: {
      simple: "fast",
      medium: "balanced",
      complex: "powerful",
      expert: "powerful",
    },
    escalation: {
      enabled: true,
      maxAttempts: 2,
    },
  },
  execution: {
    maxIterations: 10,
    iterationDelayMs: 1000,
    costLimit: 10.0,
    sessionTimeoutSeconds: 300,
    maxStoriesPerFeature: 100,
  },
  routing: {
    strategy: "keyword" as const,
  },
  quality: {
    requireTypecheck: false,
    requireLint: false,
    requireTests: false,
    commands: {},
  },
  tdd: {
    maxRetries: 2,
    autoVerifyIsolation: true,
    autoApproveVerifier: false,
  },
  constitution: {
    enabled: true,
    path: "constitution.md",
    maxTokens: 4000,
  },
  analyze: {
    llmEnhanced: true,
    model: "balanced",
    fallbackToKeywords: true,
    maxCodebaseSummaryTokens: 2000,
  },
  review: {
    enabled: false,
    checks: [],
    commands: {},
  },
  plan: {
    model: "balanced",
    outputPath: "plan.md",
  },
  acceptance: {
    enabled: false,
    maxRetries: 2,
    generateTests: false,
    testPath: "acceptance.test.ts",
  },
};

const mockStory: UserStory = {
  id: "US-001",
  title: "Test Story",
  description: "A test user story",
  acceptanceCriteria: ["AC-1: Test passes"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

const createMockContext = (): PipelineContext => ({
  config: mockConfig,
  prd: {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [mockStory],
  },
  story: mockStory,
  stories: [mockStory],
  routing: {
    complexity: "simple",
    modelTier: "fast",
    testStrategy: "test-after",
    reasoning: "Simple story",
  },
  workdir: "/test/workdir",
  hooks: {
    hooks: {},
  },
});

// ── PipelineEventEmitter Tests ──────────────────────

describe("PipelineEventEmitter", () => {
  beforeEach(() => {
    initLogger({ level: "error", useChalk: false });
  });

  afterEach(() => {
    resetLogger();
  });

  test("should emit and receive story:start events", () => {
    const emitter = new PipelineEventEmitter();
    const events: Array<{ story: UserStory; routing: unknown }> = [];

    emitter.on("story:start", (story, routing) => {
      events.push({ story, routing });
    });

    const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" } as const;
    emitter.emit("story:start", mockStory, routing);

    expect(events).toHaveLength(1);
    expect(events[0].story.id).toBe("US-001");
    expect(events[0].routing).toEqual(routing);
  });

  test("should emit and receive story:complete events", () => {
    const emitter = new PipelineEventEmitter();
    const events: Array<{ story: UserStory; result: StageResult }> = [];

    emitter.on("story:complete", (story, result) => {
      events.push({ story, result });
    });

    const result: StageResult = { action: "continue" };
    emitter.emit("story:complete", mockStory, result);

    expect(events).toHaveLength(1);
    expect(events[0].story.id).toBe("US-001");
    expect(events[0].result.action).toBe("continue");
  });

  test("should emit and receive story:escalate events", () => {
    const emitter = new PipelineEventEmitter();
    const events: Array<{ story: UserStory; fromTier: string; toTier: string }> = [];

    emitter.on("story:escalate", (story, fromTier, toTier) => {
      events.push({ story, fromTier, toTier });
    });

    emitter.emit("story:escalate", mockStory, "fast", "balanced");

    expect(events).toHaveLength(1);
    expect(events[0].story.id).toBe("US-001");
    expect(events[0].fromTier).toBe("fast");
    expect(events[0].toTier).toBe("balanced");
  });

  test("should emit and receive stage:enter events", () => {
    const emitter = new PipelineEventEmitter();
    const events: Array<{ stage: string; story: UserStory }> = [];

    emitter.on("stage:enter", (stage, story) => {
      events.push({ stage, story });
    });

    emitter.emit("stage:enter", "routing", mockStory);

    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("routing");
    expect(events[0].story.id).toBe("US-001");
  });

  test("should emit and receive stage:exit events", () => {
    const emitter = new PipelineEventEmitter();
    const events: Array<{ stage: string; result: StageResult }> = [];

    emitter.on("stage:exit", (stage, result) => {
      events.push({ stage, result });
    });

    const result: StageResult = { action: "continue" };
    emitter.emit("stage:exit", "routing", result);

    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("routing");
    expect(events[0].result.action).toBe("continue");
  });

  test("should emit and receive run:complete events", () => {
    const emitter = new PipelineEventEmitter();
    const events: Array<unknown> = [];

    emitter.on("run:complete", (summary) => {
      events.push(summary);
    });

    const summary = {
      storiesProcessed: 5,
      storiesCompleted: 4,
      storiesFailed: 1,
      storiesSkipped: 0,
      totalCost: 0.42,
      durationMs: 60000,
    };
    emitter.emit("run:complete", summary);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(summary);
  });

  test("should support once() for one-time listeners", () => {
    const emitter = new PipelineEventEmitter();
    const events: unknown[] = [];

    emitter.once("story:start", (story, routing) => {
      events.push({ story, routing });
    });

    const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" } as const;
    emitter.emit("story:start", mockStory, routing);
    emitter.emit("story:start", mockStory, routing); // Should not trigger again

    expect(events).toHaveLength(1);
  });

  test("should support off() to remove listeners", () => {
    const emitter = new PipelineEventEmitter();
    const events: unknown[] = [];

    const listener = (story: UserStory) => {
      events.push(story);
    };

    emitter.on("story:start", listener);
    const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" } as const;
    emitter.emit("story:start", mockStory, routing);

    emitter.off("story:start", listener);
    emitter.emit("story:start", mockStory, routing);

    expect(events).toHaveLength(1);
  });

  test("should support removeAllListeners() for specific event", () => {
    const emitter = new PipelineEventEmitter();
    const events: unknown[] = [];

    emitter.on("story:start", (story) => {
      events.push(story);
    });
    emitter.on("story:start", (story) => {
      events.push(story);
    });

    emitter.removeAllListeners("story:start");

    const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" } as const;
    emitter.emit("story:start", mockStory, routing);

    expect(events).toHaveLength(0);
  });

  test("should support removeAllListeners() for all events", () => {
    const emitter = new PipelineEventEmitter();
    const events: unknown[] = [];

    emitter.on("story:start", () => events.push("start"));
    emitter.on("story:complete", () => events.push("complete"));

    emitter.removeAllListeners();

    const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" } as const;
    const result: StageResult = { action: "continue" };
    emitter.emit("story:start", mockStory, routing);
    emitter.emit("story:complete", mockStory, result);

    expect(events).toHaveLength(0);
  });
});

// ── Pipeline Runner Event Emission Tests ────────────

describe("runPipeline event emission", () => {
  beforeEach(() => {
    initLogger({ level: "error", useChalk: false });
  });

  afterEach(() => {
    resetLogger();
  });

  test("should emit stage:enter and stage:exit for each stage", async () => {
    const emitter = new PipelineEventEmitter();
    const enterEvents: string[] = [];
    const exitEvents: string[] = [];

    emitter.on("stage:enter", (stage) => {
      enterEvents.push(stage);
    });
    emitter.on("stage:exit", (stage) => {
      exitEvents.push(stage);
    });

    const mockStage: PipelineStage = {
      name: "test-stage",
      enabled: () => true,
      execute: async () => ({ action: "continue" }),
    };

    const ctx = createMockContext();
    await runPipeline([mockStage], ctx, emitter);

    expect(enterEvents).toEqual(["test-stage"]);
    expect(exitEvents).toEqual(["test-stage"]);
  });

  test("should emit stage:exit with fail result on exception", async () => {
    const emitter = new PipelineEventEmitter();
    const exitEvents: Array<{ stage: string; result: StageResult }> = [];

    emitter.on("stage:exit", (stage, result) => {
      exitEvents.push({ stage, result });
    });

    const failingStage: PipelineStage = {
      name: "failing-stage",
      enabled: () => true,
      execute: async () => {
        throw new Error("Stage failed");
      },
    };

    const ctx = createMockContext();
    await runPipeline([failingStage], ctx, emitter);

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].stage).toBe("failing-stage");
    expect(exitEvents[0].result.action).toBe("fail");
    if (exitEvents[0].result.action === "fail") {
      expect(exitEvents[0].result.reason).toContain("Stage failed");
    }
  });

  test("should not emit events for disabled stages", async () => {
    const emitter = new PipelineEventEmitter();
    const enterEvents: string[] = [];

    emitter.on("stage:enter", (stage) => {
      enterEvents.push(stage);
    });

    const disabledStage: PipelineStage = {
      name: "disabled-stage",
      enabled: () => false,
      execute: async () => ({ action: "continue" }),
    };

    const ctx = createMockContext();
    await runPipeline([disabledStage], ctx, emitter);

    expect(enterEvents).toHaveLength(0);
  });

  test("should emit events in correct order for multiple stages", async () => {
    const emitter = new PipelineEventEmitter();
    const events: string[] = [];

    emitter.on("stage:enter", (stage) => {
      events.push(`enter:${stage}`);
    });
    emitter.on("stage:exit", (stage) => {
      events.push(`exit:${stage}`);
    });

    const stage1: PipelineStage = {
      name: "stage-1",
      enabled: () => true,
      execute: async () => ({ action: "continue" }),
    };
    const stage2: PipelineStage = {
      name: "stage-2",
      enabled: () => true,
      execute: async () => ({ action: "continue" }),
    };

    const ctx = createMockContext();
    await runPipeline([stage1, stage2], ctx, emitter);

    expect(events).toEqual([
      "enter:stage-1",
      "exit:stage-1",
      "enter:stage-2",
      "exit:stage-2",
    ]);
  });
});

// ── Headless Mode Detection Tests ───────────────────

describe("headless mode detection logic", () => {
  test("should use headless mode when stdout is not a TTY", () => {
    const isTTY = false;
    const headlessFlag = false;
    const headlessEnv = false;
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    expect(useHeadless).toBe(true);
  });

  test("should use headless mode when --headless flag is passed", () => {
    const isTTY = true;
    const headlessFlag = true;
    const headlessEnv = false;
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    expect(useHeadless).toBe(true);
  });

  test("should use headless mode when NAX_HEADLESS=1", () => {
    const isTTY = true;
    const headlessFlag = false;
    const headlessEnv = true;
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    expect(useHeadless).toBe(true);
  });

  test("should use TUI mode when stdout is TTY and no headless flags", () => {
    const isTTY = true;
    const headlessFlag = false;
    const headlessEnv = false;
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    expect(useHeadless).toBe(false);
  });

  test("headless flag should override TTY detection", () => {
    const isTTY = true; // Even with TTY
    const headlessFlag = true; // --headless forces pipe mode
    const headlessEnv = false;
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    expect(useHeadless).toBe(true);
  });

  test("NAX_HEADLESS env should override TTY detection", () => {
    const isTTY = true; // Even with TTY
    const headlessFlag = false;
    const headlessEnv = true; // NAX_HEADLESS=1 forces pipe mode
    const useHeadless = !isTTY || headlessFlag || headlessEnv;

    expect(useHeadless).toBe(true);
  });
});
