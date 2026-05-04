/**
 * Post-Run Context Extension Tests — Curator Fields
 */

import { describe, expect, test } from "bun:test";
import type { PostRunContext } from "../../../src/plugins/extensions";

describe("PostRunContext curator extensions", () => {
  test("should support outputDir field", () => {
    const context: PostRunContext = {
      runId: "run-123",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      outputDir: "/home/user/.nax/project",
    };

    expect(context.outputDir).toBe("/home/user/.nax/project");
  });

  test("should support globalDir field", () => {
    const context: PostRunContext = {
      runId: "run-456",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      globalDir: "/home/user/.nax/global",
    };

    expect(context.globalDir).toBe("/home/user/.nax/global");
  });

  test("should support projectKey field", () => {
    const context: PostRunContext = {
      runId: "run-789",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      projectKey: "my-project",
    };

    expect(context.projectKey).toBe("my-project");
  });

  test("should support curatorRollupPath field", () => {
    const context: PostRunContext = {
      runId: "run-101",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
    };

    expect(context.curatorRollupPath).toBe("/home/user/.nax/global/curator/rollup.jsonl");
  });

  test("should support logFilePath field", () => {
    const context: PostRunContext = {
      runId: "run-202",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      logFilePath: "/tmp/test.jsonl",
    };

    expect(context.logFilePath).toBe("/tmp/test.jsonl");
  });

  test("should support config field", () => {
    const config = {
      curator: { enabled: true },
      review: { audit: { enabled: true } },
    };

    const context: PostRunContext = {
      runId: "run-303",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config,
    };

    expect(context.config).toEqual(config);
  });

  test("should support all curator fields together", () => {
    const context: PostRunContext = {
      runId: "run-404",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      outputDir: "/home/user/.nax/project",
      globalDir: "/home/user/.nax/global",
      projectKey: "my-project",
      curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
      logFilePath: "/tmp/run.jsonl",
      config: { curator: { enabled: true } },
    };

    expect(context.outputDir).toBe("/home/user/.nax/project");
    expect(context.globalDir).toBe("/home/user/.nax/global");
    expect(context.projectKey).toBe("my-project");
    expect(context.curatorRollupPath).toBe("/home/user/.nax/global/curator/rollup.jsonl");
    expect(context.logFilePath).toBe("/tmp/run.jsonl");
    expect(context.config).toBeDefined();
  });

  test("should be backward compatible without curator fields", () => {
    const context: PostRunContext = {
      runId: "run-505",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    // Should still be valid without curator fields
    expect(context.runId).toBe("run-505");
    expect(context.outputDir).toBeUndefined();
    expect(context.globalDir).toBeUndefined();
  });
});
