/**
 * Tests for src/plugins/index.ts barrel exports
 *
 * Covers: IPostRunAction, PostRunContext, PostRunActionResult exported from index.ts
 */

import { describe, expect, it } from "bun:test";

// Import directly from the barrel to verify re-exports
import type {
  IPostRunAction,
  PostRunActionResult,
  PostRunContext,
} from "../../../src/plugins";

// ─────────────────────────────────────────────────────────────────────────────
// Index barrel exports tests
// ─────────────────────────────────────────────────────────────────────────────

describe("src/plugins/index.ts exports", () => {
  it("should export IPostRunAction type from barrel", () => {
    const action: IPostRunAction = {
      name: "test-action",
      description: "Test action",
      shouldRun: async () => true,
      execute: async () => ({ success: true, message: "Done" }),
    };
    expect(action.name).toBe("test-action");
  });

  it("should export PostRunContext type from barrel", () => {
    const context: PostRunContext = {
      runId: "run-123",
      feature: "feature",
      workdir: "/work",
      prdPath: "/work/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 5.0,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "1.0.0",
      pluginConfig: {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    };
    expect(context.runId).toBe("run-123");
  });

  it("should export PostRunActionResult type from barrel", () => {
    const result: PostRunActionResult = {
      success: true,
      message: "Done",
      url: "https://example.com",
    };
    expect(result.success).toBe(true);
  });

  it("should allow full plugin definition using barrel exports", () => {
    const action: IPostRunAction = {
      name: "barrel-test",
      description: "Test via barrel",
      shouldRun: async (ctx: PostRunContext) => {
        void ctx;
        return true;
      },
      execute: async (ctx: PostRunContext): Promise<PostRunActionResult> => {
        void ctx;
        return { success: true, message: "OK" };
      },
    };

    expect(action).toBeDefined();
  });
});
