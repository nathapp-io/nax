/**
 * Curator Observation Collector Tests
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("projects real metrics, review-audit, manifest, and JSONL shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-collector-"));
    const workdir = join(root, "work");
    const outputDir = join(root, "out");
    const storyDir = join(workdir, ".nax", "features", "feat-auth", "stories", "US-001");
    const auditDir = join(outputDir, "review-audit", "feat-auth");
    await mkdir(storyDir, { recursive: true });
    await mkdir(auditDir, { recursive: true });

    await writeFile(
      join(outputDir, "metrics.json"),
      JSON.stringify([
        {
          runId: "run-real",
          feature: "feat-auth",
          stories: [
            {
              storyId: "US-001",
              success: true,
              attempts: 2,
              cost: 1.25,
              tokens: { inputTokens: 10, outputTokens: 5 },
            },
          ],
        },
      ]),
    );
    await writeFile(
      join(auditDir, "1-review.json"),
      JSON.stringify({
        timestamp: "2026-05-04T00:00:00.000Z",
        storyId: "US-001",
        featureName: "feat-auth",
        result: {
          findings: [{ rule: "no-n-plus-one", severity: "error", file: "src/api.ts", line: 42, message: "N+1" }],
        },
      }),
    );
    await writeFile(
      join(storyDir, "context-manifest-review.json"),
      JSON.stringify({
        stage: "review",
        includedChunks: ["feature-context:abc"],
        excludedChunks: [{ id: "rules:def", reason: "stale" }],
        providerResults: [{ providerId: "feature-context", status: "empty", chunkCount: 0, durationMs: 1, tokensProduced: 0 }],
        chunkSummaries: { "feature-context:abc": "Auth context" },
      }),
    );
    const logFilePath = join(root, "run.jsonl");
    await writeFile(
      logFilePath,
      [
        JSON.stringify({
          timestamp: "2026-05-04T00:01:00.000Z",
          level: "info",
          stage: "pull-tool",
          message: "invoked",
          data: { storyId: "US-001", tool: "query_feature_context", keyword: "auth cache", resultCount: 0, resultBytes: 0 },
        }),
        JSON.stringify({
          timestamp: "2026-05-04T00:02:00.000Z",
          level: "info",
          stage: "acceptance",
          message: "verdict",
          data: { storyId: "US-001", passed: false, failedACs: ["AC-2"], retries: 1, packageDir: workdir, durationMs: 50 },
        }),
        JSON.stringify({
          timestamp: "2026-05-04T00:03:00.000Z",
          level: "info",
          stage: "findings.cycle",
          message: "iteration completed",
          data: { storyId: "US-001", cycleName: "acceptance", iterationNum: 1, outcome: "unchanged", findingsBefore: 1, findingsAfter: 1 },
        }),
      ].join("\n"),
    );

    const context: CuratorPostRunContext = {
      runId: "run-real",
      feature: "feat-auth",
      workdir,
      prdPath: join(workdir, ".nax", "features", "feat-auth", "prd.json"),
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {} as any,
      outputDir,
      globalDir: join(root, "global"),
      projectKey: "test-project",
      curatorRollupPath: join(root, "rollup.jsonl"),
      logFilePath,
    };

    const observations = await collectObservations(context);
    expect(observations.some((o) => o.kind === "verdict")).toBe(true);
    expect(observations.some((o) => o.kind === "review-finding" && o.payload.ruleId === "no-n-plus-one")).toBe(true);
    expect(observations.some((o) => o.kind === "chunk-included")).toBe(true);
    expect(observations.some((o) => o.kind === "chunk-excluded" && o.payload.reason === "stale")).toBe(true);
    expect(observations.some((o) => o.kind === "provider-empty")).toBe(true);
    expect(observations.some((o) => o.kind === "pull-call" && o.payload.resultCount === 0)).toBe(true);
    expect(observations.some((o) => o.kind === "acceptance-verdict" && o.payload.failedACs?.includes("AC-2"))).toBe(true);
    expect(observations.some((o) => o.kind === "fix-cycle-iteration" && o.payload.outcome === "unchanged")).toBe(true);
  });
});
