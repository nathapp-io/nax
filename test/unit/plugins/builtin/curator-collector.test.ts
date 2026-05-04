/**
 * Curator Observation Collector Tests
 */

import { describe, expect, test } from "bun:test";
import { collectObservations } from "../../../../src/plugins/builtin/curator";
import type { CuratorPostRunContext } from "../../../../src/plugins/builtin/curator";

describe("collectObservations", () => {
  test("should return an array of observations", async () => {
    const context: CuratorPostRunContext = {
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const observations = await collectObservations(context);
    expect(Array.isArray(observations)).toBe(true);
  });

  test("should return observations with schemaVersion=1", async () => {
    const context: CuratorPostRunContext = {
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const observations = await collectObservations(context);
    if (observations.length > 0) {
      expect(observations[0].schemaVersion).toBe(1);
    }
  });

  test("should include runId in observations", async () => {
    const runId = "run-789";
    const context: CuratorPostRunContext = {
      runId,
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const observations = await collectObservations(context);
    if (observations.length > 0) {
      expect(observations[0].runId).toBe(runId);
    }
  });

  test("should include required observation fields", async () => {
    const context: CuratorPostRunContext = {
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const observations = await collectObservations(context);
    if (observations.length > 0) {
      const obs = observations[0];
      expect(obs).toHaveProperty("schemaVersion");
      expect(obs).toHaveProperty("runId");
      expect(obs).toHaveProperty("featureId");
      expect(obs).toHaveProperty("storyId");
      expect(obs).toHaveProperty("stage");
      expect(obs).toHaveProperty("ts");
      expect(obs).toHaveProperty("kind");
      expect(obs).toHaveProperty("payload");
    }
  });

  test("should never throw on missing outputDir", async () => {
    const context: CuratorPostRunContext = {
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
      config: {} as any,
      outputDir: "/nonexistent/path",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    // Should not throw
    const observations = await collectObservations(context);
    expect(Array.isArray(observations)).toBe(true);
  });

  test("should never throw on missing logFilePath", async () => {
    const context: CuratorPostRunContext = {
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
      logFilePath: undefined,
    };

    // Should not throw
    const observations = await collectObservations(context);
    expect(Array.isArray(observations)).toBe(true);
  });

  test("should handle missing context manifests gracefully", async () => {
    const context: CuratorPostRunContext = {
      runId: "run-404",
      feature: "test-feature",
      workdir: "/tmp/nonexistent",
      prdPath: "/tmp/test/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    // Should not throw
    const observations = await collectObservations(context);
    expect(Array.isArray(observations)).toBe(true);
  });

  test("should read metrics.json from outputDir when available", async () => {
    const context: CuratorPostRunContext = {
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const observations = await collectObservations(context);
    // TODO: Verify metrics.json was read after implementation
    expect(Array.isArray(observations)).toBe(true);
  });

  test("should read review-audit/*.json from outputDir when available", async () => {
    const context: CuratorPostRunContext = {
      runId: "run-606",
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
      config: {} as any,
      outputDir: "/tmp/output",
      globalDir: "/tmp/global",
      projectKey: "test-project",
      curatorRollupPath: "/tmp/rollup.jsonl",
    };

    const observations = await collectObservations(context);
    // TODO: Verify review-audit was read after implementation
    expect(Array.isArray(observations)).toBe(true);
  });
});
