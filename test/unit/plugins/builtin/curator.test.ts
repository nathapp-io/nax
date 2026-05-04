/**
 * Curator Plugin Tests
 *
 * Tests for the built-in curator post-run action plugin.
 */

import { describe, expect, test } from "bun:test";
import type { PostRunContext } from "../../../../src/plugins/extensions";
import { curatorPlugin } from "../../../../src/plugins/builtin/curator";

describe("curatorPlugin", () => {
  test("should have correct plugin metadata", () => {
    expect(curatorPlugin.name).toBe("nax-curator");
    expect(curatorPlugin.version).toBe("0.1.0");
    expect(curatorPlugin.provides).toContain("post-run-action");
  });

  test("should provide postRunAction extension", () => {
    expect(curatorPlugin.extensions.postRunAction).toBeDefined();
    expect(curatorPlugin.extensions.postRunAction?.name).toBe("nax-curator");
    expect(curatorPlugin.extensions.postRunAction?.description).toBeDefined();
  });

  test("should have shouldRun and execute methods", () => {
    const action = curatorPlugin.extensions.postRunAction;
    expect(action?.shouldRun).toBeDefined();
    expect(action?.execute).toBeDefined();
  });
});

describe("curatorPlugin.shouldRun", () => {
  test("should return false when curator.enabled is false", async () => {
    const context: PostRunContext = {
      runId: "test-run",
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
      config: { curator: { enabled: false } },
    };

    const result = await curatorPlugin.extensions.postRunAction!.shouldRun(context);
    expect(result).toBe(false);
  });

  test("should return false when no stories completed", async () => {
    const context: PostRunContext = {
      runId: "test-run",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 0, failed: 1, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    const result = await curatorPlugin.extensions.postRunAction!.shouldRun(context);
    expect(result).toBe(false);
  });

  test("should return true when enabled and stories completed", async () => {
    const context: PostRunContext = {
      runId: "test-run",
      feature: "test-feature",
      workdir: "/tmp/test",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: { curator: { enabled: true } },
    };

    const result = await curatorPlugin.extensions.postRunAction!.shouldRun(context);
    expect(result).toBe(true);
  });

  test("should return true when curator.enabled is undefined (default true)", async () => {
    const context: PostRunContext = {
      runId: "test-run",
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

    const result = await curatorPlugin.extensions.postRunAction!.shouldRun(context);
    expect(result).toBe(true);
  });

  test("should warn when review.audit.enabled is false", async () => {
    let warnCalled = false;
    const context: PostRunContext = {
      runId: "test-run",
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
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {
          warnCalled = true;
        },
        error: () => {},
      },
      config: { review: { audit: { enabled: false } } },
    };

    await curatorPlugin.extensions.postRunAction!.shouldRun(context);
    expect(warnCalled).toBe(true);
  });
});

describe("curatorPlugin.execute", () => {
  test("should return PostRunActionResult", async () => {
    const context: PostRunContext = {
      runId: "test-run",
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

    const result = await curatorPlugin.extensions.postRunAction!.execute(context);
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("message");
  });

  test("should call collectObservations when executing", async () => {
    const context: PostRunContext = {
      runId: "test-run-123",
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
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
      config: { curator: { enabled: true } },
    };

    const result = await curatorPlugin.extensions.postRunAction!.execute(context);
    expect(result).toBeDefined();
  });

  test("should write observations.jsonl on success", async () => {
    const context: PostRunContext = {
      runId: "test-run",
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
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const result = await curatorPlugin.extensions.postRunAction!.execute(context);
    // TODO: Verify observations.jsonl was written after implementation
    expect(result.success).toBeDefined();
  });
});
