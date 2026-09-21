/**
 * Curator Heuristics Tests
 *
 * Tests for H1-H6 heuristics that convert observations into proposals.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "@test/helpers";
import type { PostRunContext } from "@/plugins";
import type { Observation } from "@/plugins/builtin/curator";
import { DEFAULT_RETENTION, getCuratorRetention, maybePruneRollup } from "@/plugins/builtin/curator";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";
import { _curatorPruneDeps, type PruneResult } from "@/plugins/builtin/curator/rollup-prune";

describe("runHeuristics", () => {
  const defaultThresholds: CuratorThresholds = {
    repeatedFinding: 2,
    emptyKeyword: 2,
    rectifyAttempts: 3,
    escalationChain: 2,
    staleChunkRuns: 2,
    unchangedOutcome: 3,
  };

  test("returns empty array for empty observations and non-triggering observations", () => {
    expect(runHeuristics([], defaultThresholds)).toEqual([]);
    const obs: Observation[] = [
      {
        schemaVersion: 1,
        projectKey: "test-proj",
        runId: "run-1",
        featureId: "feat-story-1",
        storyId: "story-1",
        stage: "context",
        ts: "2026-05-04T00:00:00Z",
        kind: "chunk-included",
        payload: { chunkId: "c1", label: "chunk 1", tokens: 100 },
      },
    ];
    expect(runHeuristics(obs, defaultThresholds)).toEqual([]);
  });

  test("uses default thresholds when config values are absent", () => {
    const obs: Observation[] = [
      {
        schemaVersion: 1,
        projectKey: "test-proj",
        runId: "run-1",
        featureId: "feat-story-1",
        storyId: "story-1",
        stage: "review",
        ts: "2026-05-04T00:00:00Z",
        kind: "review-finding",
        payload: {
          ruleId: "rule1",
          severity: "error",
          file: "src/index.ts",
          line: 10,
          message: "test error",
        },
      },
    ];
    const incompleteThresholds: Partial<CuratorThresholds> = {};
    // Should not throw and should use sensible defaults
    const proposals = runHeuristics(obs, incompleteThresholds as CuratorThresholds);
    expect(Array.isArray(proposals)).toBe(true);
  });

  describe("H1 — Repeated Review Finding", () => {
    test("triggers when same checkId count >= threshold across stories", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-2",
          storyId: "story-2",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
      ];

      const proposals = runHeuristics(obs, { ...defaultThresholds, repeatedFinding: 2 });
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1).toBeDefined();
      expect(h1?.severity).toBe("MED");
      // Description carries a distinguishing gist, never a bare category (#942);
      // the file locus moved to evidence, since it is not part of cross-feature
      // identity (#1422).
      expect(h1?.description).toContain("2 features");
      expect(h1?.description).toContain("test error");
      expect(h1?.evidence).toContain("src/index.ts");
      expect(h1?.target.action).toBe("add");
    });

    test("produces HIGH severity at wide feature spread; does not trigger for 1 feature", () => {
      const highObs: Observation[] = Array.from({ length: 5 }, (_, i) => ({
        schemaVersion: 1 as const,
        projectKey: "test-proj",
        runId: "run-1",
        featureId: `feat-${i}`,
        storyId: `story-${i}`,
        stage: "review" as const,
        ts: "2026-05-04T00:00:00Z",
        kind: "review-finding" as const,
        payload: { ruleId: "rule1", severity: "error", file: "src/index.ts", line: 10 + i, message: "test error" },
      }));
      expect(
        runHeuristics(highObs, { ...defaultThresholds, repeatedFinding: 2 }).find((p) => p.id === "H1")?.severity,
      ).toBe("HIGH");

      const singleObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: { ruleId: "rule1", severity: "error", file: "src/index.ts", line: 10, message: "test error" },
        },
      ];
      expect(
        runHeuristics(singleObs, { ...defaultThresholds, repeatedFinding: 2 }).find((p) => p.id === "H1"),
      ).toBeUndefined();
    });

    test("includes storyIds in evidence", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-a",
          storyId: "story-a",
          stage: "review",
          ts: "2026-05-04T00:00:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 10,
            message: "test error",
          },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-b",
          storyId: "story-b",
          stage: "review",
          ts: "2026-05-04T00:01:00Z",
          kind: "review-finding",
          payload: {
            ruleId: "rule1",
            severity: "error",
            file: "src/index.ts",
            line: 15,
            message: "test error",
          },
        },
      ];

      const proposals = runHeuristics(obs, { ...defaultThresholds, repeatedFinding: 2 });
      const h1 = proposals.find((p) => p.id === "H1");

      // Story IDs alone collide across features; the pair is the site reference.
      expect(h1?.storyIds).toContain("feat-story-a/story-a");
      expect(h1?.storyIds).toContain("feat-story-b/story-b");
    });
  });

  describe("H2 — Pull-tool Empty Result", () => {
    test("triggers for empty keyword results; does not trigger for non-empty results", () => {
      const emptyObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:00:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "pull",
          ts: "2026-05-04T00:01:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
      ];
      const h2 = runHeuristics(emptyObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2");
      expect(h2).toBeDefined();
      expect(h2?.severity).toBe("MED");
      expect(h2?.target.action).toBe("add");
      expect(h2?.description).toContain("review batch");

      const nonEmptyObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:00:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 2, status: "completed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "pull",
          ts: "2026-05-04T00:01:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 1, status: "completed" },
        },
      ];
      expect(
        runHeuristics(nonEmptyObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2"),
      ).toBeUndefined();
    });

    test("targets the project-level rules file, not the oldest evidence row's feature, when sites span multiple features (#1929)", () => {
      const crossFeatureObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-context-fragments",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:00:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-billing",
          storyId: "story-2",
          stage: "pull",
          ts: "2026-05-04T00:01:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-onboarding",
          storyId: "story-3",
          stage: "pull",
          ts: "2026-05-04T00:02:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
      ];

      const h2 = runHeuristics(crossFeatureObs, { ...defaultThresholds, emptyKeyword: 2 }).find((p) => p.id === "H2");
      expect(h2).toBeDefined();
      expect(h2?.target.canonicalFile).toBe(".nax/rules/curator-suggestions.md");
      expect(h2?.target.canonicalFile).not.toContain("feature-context-fragments");
      expect(h2?.target.canonicalFile).not.toContain(".nax/features/");
      // Evidence should still let a human see which features the pattern spans.
      expect(h2?.evidence).toContain("feature-context-fragments");
      expect(h2?.evidence).toContain("feature-billing");
      expect(h2?.evidence).toContain("feature-onboarding");
    });
  });

  describe("H3 — Repeated Rectification Cycle", () => {
    test("triggers when same story >= threshold; does not trigger for different stories", () => {
      const sameStoryObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:00:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:01:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 2, status: "failed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:02:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 3, status: "failed" },
        },
      ];
      const h3 = runHeuristics(sameStoryObs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3");
      expect(h3).toBeDefined();
      expect(h3?.severity).toBe("HIGH");
      expect(h3?.target.action).toBe("add");

      const diffStoryObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:00:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "rectify",
          ts: "2026-05-04T00:01:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
      ];
      expect(
        runHeuristics(diffStoryObs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3"),
      ).toBeUndefined();
    });

    test("guard: H3 stays targeted at the story's own per-feature context.md, unlike H2/H4 (#1929)", () => {
      const obs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-billing",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:00:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 1, status: "failed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-billing",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:01:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 2, status: "failed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-billing",
          storyId: "story-1",
          stage: "rectify",
          ts: "2026-05-04T00:02:00Z",
          kind: "rectify-cycle",
          payload: { iteration: 3, status: "failed" },
        },
      ];
      const h3 = runHeuristics(obs, { ...defaultThresholds, rectifyAttempts: 3 }).find((p) => p.id === "H3");
      expect(h3).toBeDefined();
      expect(h3?.target.canonicalFile).toBe(".nax/features/feature-billing/context.md");
    });
  });
});

// ---------------------------------------------------------------------------
// Curator auto-prune size gate (US-004). Absorbed from
// curator-maybe-prune-rollup.test.ts.
// ---------------------------------------------------------------------------

/** Minimal post-run context with a no-op logger. */
function makePruneContext(opts: {
  outputDir: string;
  globalDir: string;
  curatorRollupPath: string;
  projectKey: string;
}): PostRunContext {
  return {
    runId: "test-run",
    feature: "feat-test",
    workdir: path.join(opts.outputDir, "work"),
    prdPath: path.join(opts.outputDir, "work", ".nax", "features", "feat-test", "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 10,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    outputDir: opts.outputDir,
    globalDir: opts.globalDir,
    projectKey: opts.projectKey,
    curatorRollupPath: opts.curatorRollupPath,
  };
}

async function writeRollupWithNRuns(rollupPath: string, countRows: number, projectKey: string): Promise<number> {
  await mkdir(path.dirname(rollupPath), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < countRows; i += 1) {
    const obs: Observation = {
      schemaVersion: 3,
      projectKey,
      runId: `run-${String(i).padStart(4, "0")}`,
      featureId: "feat-test",
      storyId: "US-001",
      stage: "review",
      ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      kind: "verdict",
      payload: { status: "completed", cost: 0, tokens: 0 },
    };
    lines.push(JSON.stringify(obs));
  }
  await writeFile(rollupPath, `${lines.join("\n")}\n`);
  return Bun.file(rollupPath).size;
}

type ScanAndPruneCall = {
  rollupPath: string;
  projectKey: string;
  keepRuns: number;
};

describe("maybePruneRollup — size gate (US-004)", () => {
  let origScanAndPrune: typeof _curatorPruneDeps.scanAndPruneNewest;
  let scanAndPruneCalls: ScanAndPruneCall[];
  let scanAndPruneImpl: typeof _curatorPruneDeps.scanAndPruneNewest;

  beforeEach(() => {
    scanAndPruneCalls = [];
    origScanAndPrune = _curatorPruneDeps.scanAndPruneNewest;
    scanAndPruneImpl = (async (rollupPath: string, projectKey: string, keepRuns: number) => {
      scanAndPruneCalls.push({ rollupPath, projectKey, keepRuns });
      const ok: PruneResult = { kept: 0, dropped: 0, keptOtherProjects: 0, keptUnattributed: 0 };
      return ok;
    }) as typeof _curatorPruneDeps.scanAndPruneNewest;
    _curatorPruneDeps.scanAndPruneNewest = scanAndPruneImpl;
  });

  afterEach(() => {
    _curatorPruneDeps.scanAndPruneNewest = origScanAndPrune;
  });

  test("AC3: over-threshold rollup → pruneRollup invoked once with keepRunIds of at most retention.keepRuns", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      await writeRollupWithNRuns(rollupPath, 200, "test-project");
      const size = Bun.file(rollupPath).size;
      expect(size).toBeGreaterThan(0);

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: size - 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(true);
      expect(scanAndPruneCalls).toHaveLength(1);
      expect(scanAndPruneCalls[0]?.rollupPath).toBe(rollupPath);
      expect(scanAndPruneCalls[0]?.projectKey).toBe("test-project");
      expect(scanAndPruneCalls[0]?.keepRuns).toBeLessThanOrEqual(50);
      expect(scanAndPruneCalls[0]?.keepRuns).toBeGreaterThan(0);
    });
  });

  test("AC4: under-threshold rollup → pruneRollup is NOT invoked", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 5, "test-project");

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: size + 1024, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(scanAndPruneCalls).toHaveLength(0);
    });
  });

  test("AC5: size exactly equal to threshold → pruneRollup is NOT invoked (gate opens strictly above)", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 5, "test-project");

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: size, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(scanAndPruneCalls).toHaveLength(0);
    });
  });

  test("AC6: pruneRollup rejection → maybePruneRollup resolves with pruned:false and an error string", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 200, "test-project");

      _curatorPruneDeps.scanAndPruneNewest = (async () => {
        throw new Error("disk full");
      }) as typeof _curatorPruneDeps.scanAndPruneNewest;

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: size - 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(typeof result.error).toBe("string");
      expect(result.error?.length ?? 0).toBeGreaterThan(0);
    });
  });

  test("AC7: missing rollup path → no pruneRollup call, resolves without rejecting", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "does-not-exist.jsonl");
      expect(await Bun.file(rollupPath).exists()).toBe(false);

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(scanAndPruneCalls).toHaveLength(0);
    });
  });
});

describe("getCuratorRetention — schema-default fallback (US-004)", () => {
  test("AC12: returns DEFAULT_RETENTION values when context carries no curator configuration", () => {
    const ctx = makePruneContext({
      outputDir: "/tmp/doesnt-matter",
      globalDir: "/tmp/doesnt-matter",
      curatorRollupPath: "/tmp/doesnt-matter.jsonl",
      projectKey: "test-project",
    });

    const retention = getCuratorRetention(ctx);

    expect(retention.pruneThresholdBytes).toBe(DEFAULT_RETENTION.pruneThresholdBytes);
    expect(retention.pruneThresholdBytes).toBe(67108864);
    expect(retention.keepRuns).toBe(DEFAULT_RETENTION.keepRuns);
    expect(retention.keepRuns).toBe(50);
  });

  test("AC12 boundary: returns DEFAULT_RETENTION values when context carries curator config with retention unset", () => {
    const ctx = makePruneContext({
      outputDir: "/tmp/doesnt-matter",
      globalDir: "/tmp/doesnt-matter",
      curatorRollupPath: "/tmp/doesnt-matter.jsonl",
      projectKey: "test-project",
    });
    ctx.config = { curator: { enabled: true } };

    const retention = getCuratorRetention(ctx);

    expect(retention.pruneThresholdBytes).toBe(67108864);
    expect(retention.keepRuns).toBe(50);
  });

  test("AC12 boundary: returns curator config retention when it is fully set", () => {
    const ctx = makePruneContext({
      outputDir: "/tmp/doesnt-matter",
      globalDir: "/tmp/doesnt-matter",
      curatorRollupPath: "/tmp/doesnt-matter.jsonl",
      projectKey: "test-project",
    });
    ctx.config = {
      curator: {
        retention: { pruneThresholdBytes: 1024, keepRuns: 7 },
      },
    };

    const retention = getCuratorRetention(ctx);

    expect(retention.pruneThresholdBytes).toBe(1024);
    expect(retention.keepRuns).toBe(7);
  });
});
