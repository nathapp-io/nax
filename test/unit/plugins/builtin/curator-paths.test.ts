/**
 * Curator Path Resolution Tests
 */

import { describe, expect, test } from "bun:test";
import { resolveCuratorOutputs } from "../../../../src/plugins/builtin/curator/paths";
import type { CuratorPostRunContext } from "../../../../src/plugins/builtin/curator";

describe("resolveCuratorOutputs", () => {
  test("should resolve observations path under outputDir/runs/<runId>/", () => {
    const context: CuratorPostRunContext = {
      runId: "run-abc123",
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
      outputDir: "/home/user/.nax/project123",
      globalDir: "/home/user/.nax/global",
      projectKey: "project123",
      curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths.observationsPath).toContain("run-abc123");
    expect(paths.observationsPath).toContain("observations.jsonl");
  });

  test("should resolve proposals path under outputDir/runs/<runId>/", () => {
    const context: CuratorPostRunContext = {
      runId: "run-def456",
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
      outputDir: "/home/user/.nax/project123",
      globalDir: "/home/user/.nax/global",
      projectKey: "project123",
      curatorRollupPath: "/home/user/.nax/global/curator/rollup.jsonl",
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths.proposalsPath).toContain("run-def456");
    expect(paths.proposalsPath).toContain("proposals.jsonl");
  });

  test("should use context.curatorRollupPath as rollup path", () => {
    const rollupPath = "/home/user/.nax/global/curator/rollup.jsonl";
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
      outputDir: "/home/user/.nax/project123",
      globalDir: "/home/user/.nax/global",
      projectKey: "project123",
      curatorRollupPath: rollupPath,
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths.rollupPath).toBe(rollupPath);
  });

  test("should return all three paths", () => {
    const context: CuratorPostRunContext = {
      runId: "run-xyz",
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
      outputDir: "/output",
      globalDir: "/global",
      projectKey: "proj",
      curatorRollupPath: "/global/rollup.jsonl",
    };

    const paths = resolveCuratorOutputs(context);
    expect(paths).toHaveProperty("observationsPath");
    expect(paths).toHaveProperty("proposalsPath");
    expect(paths).toHaveProperty("rollupPath");
  });
});
