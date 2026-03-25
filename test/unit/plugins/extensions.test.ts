/**
 * Tests for post-run-action types in src/plugins/extensions.ts
 *
 * Covers: IPostRunAction, PostRunContext, PostRunActionResult interface definitions
 */

import { describe, expect, it } from "bun:test";
import type {
  IPostRunAction,
  PostRunActionResult,
  PostRunContext,
} from "../../../src/plugins/extensions";

// ─────────────────────────────────────────────────────────────────────────────
// IPostRunAction interface tests
// ─────────────────────────────────────────────────────────────────────────────

describe("IPostRunAction interface", () => {
  it("should have name property as string", () => {
    const action: IPostRunAction = {
      name: "test-action",
      description: "Test description",
      shouldRun: async () => true,
      execute: async () => ({ success: true, message: "OK" }),
    };
    expect(action.name).toBe("test-action");
    expect(typeof action.name).toBe("string");
  });

  it("should have description property as string", () => {
    const action: IPostRunAction = {
      name: "test",
      description: "A test description",
      shouldRun: async () => true,
      execute: async () => ({ success: true, message: "OK" }),
    };
    expect(action.description).toBe("A test description");
    expect(typeof action.description).toBe("string");
  });

  it("should have shouldRun method that accepts PostRunContext", () => {
    const action: IPostRunAction = {
      name: "test",
      description: "Test",
      shouldRun: async (context: PostRunContext) => {
        // Verify context has expected properties
        expect(context).toHaveProperty("runId");
        expect(context).toHaveProperty("feature");
        return true;
      },
      execute: async () => ({ success: true, message: "OK" }),
    };
    expect(typeof action.shouldRun).toBe("function");
  });

  it("should have execute method that accepts PostRunContext and returns Promise<PostRunActionResult>", () => {
    const action: IPostRunAction = {
      name: "test",
      description: "Test",
      shouldRun: async () => true,
      execute: async (context: PostRunContext): Promise<PostRunActionResult> => {
        // Verify context properties are accessible
        void context.runId;
        void context.feature;
        return {
          success: true,
          message: "Completed",
        };
      },
    };
    expect(typeof action.execute).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PostRunContext interface tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PostRunContext interface", () => {
  it("should have all required fields", () => {
    const context: PostRunContext = {
      runId: "run-123",
      feature: "test-feature",
      workdir: "/path/to/work",
      prdPath: "/path/to/prd.json",
      branch: "main",
      totalDurationMs: 5000,
      totalCost: 10.5,
      storySummary: {
        completed: 2,
        failed: 0,
        skipped: 1,
        paused: 0,
      },
      stories: [],
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      },
    };

    expect(context.runId).toBe("run-123");
    expect(context.feature).toBe("test-feature");
    expect(context.workdir).toBe("/path/to/work");
    expect(context.prdPath).toBe("/path/to/prd.json");
    expect(context.branch).toBe("main");
    expect(context.totalDurationMs).toBe(5000);
    expect(context.totalCost).toBe(10.5);
    expect(context.storySummary.completed).toBe(2);
    expect(context.stories).toEqual([]);
    expect(context.version).toBe("1.0.0");
    expect(context.pluginConfig).toEqual({});
    expect(context.logger).toBeDefined();
  });

  it("should have storySummary with completed, failed, skipped, paused counts", () => {
    const context: PostRunContext = {
      runId: "run-123",
      feature: "test-feature",
      workdir: "/path/to/work",
      prdPath: "/path/to/prd.json",
      branch: "main",
      totalDurationMs: 5000,
      totalCost: 10.5,
      storySummary: {
        completed: 5,
        failed: 1,
        skipped: 2,
        paused: 0,
      },
      stories: [],
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      },
    };

    expect(context.storySummary).toEqual({
      completed: 5,
      failed: 1,
      skipped: 2,
      paused: 0,
    });
  });

  it("should have logger with debug, info, warn, error methods", () => {
    const context: PostRunContext = {
      runId: "run-123",
      feature: "test-feature",
      workdir: "/path/to/work",
      prdPath: "/path/to/prd.json",
      branch: "main",
      totalDurationMs: 5000,
      totalCost: 10.5,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        debug: (msg: string) => void msg,
        info: (msg: string) => void msg,
        warn: (msg: string) => void msg,
        error: (msg: string) => void msg,
      },
    };

    expect(typeof context.logger.debug).toBe("function");
    expect(typeof context.logger.info).toBe("function");
    expect(typeof context.logger.warn).toBe("function");
    expect(typeof context.logger.error).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PostRunActionResult interface tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PostRunActionResult interface", () => {
  it("should have required success and message fields", () => {
    const result: PostRunActionResult = {
      success: true,
      message: "Action completed successfully",
    };

    expect(result.success).toBe(true);
    expect(result.message).toBe("Action completed successfully");
  });

  it("should support optional url field", () => {
    const result: PostRunActionResult = {
      success: true,
      message: "Action completed",
      url: "https://example.com/report",
    };

    expect(result.url).toBe("https://example.com/report");
  });

  it("should support optional skipped field", () => {
    const result: PostRunActionResult = {
      success: true,
      message: "Action skipped",
      skipped: true,
    };

    expect(result.skipped).toBe(true);
  });

  it("should support optional reason field", () => {
    const result: PostRunActionResult = {
      success: false,
      message: "Action failed",
      reason: "Configuration missing",
    };

    expect(result.reason).toBe("Configuration missing");
  });

  it("should support multiple optional fields together", () => {
    const result: PostRunActionResult = {
      success: true,
      message: "Partial success",
      url: "https://example.com",
      skipped: false,
      reason: "Some checks were skipped",
    };

    expect(result).toEqual({
      success: true,
      message: "Partial success",
      url: "https://example.com",
      skipped: false,
      reason: "Some checks were skipped",
    });
  });

  it("should allow success false with reason", () => {
    const result: PostRunActionResult = {
      success: false,
      message: "Action failed",
      reason: "Network timeout",
    };

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Network timeout");
  });
});
