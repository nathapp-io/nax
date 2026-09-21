/**
 * H4-H6 heuristics — escalation chains, stale chunks, fix-cycle outcomes,
 * plus the multi-heuristic and evidence/metadata guards.
 *
 * Split from curator-heuristics.test.ts, which crossed the 800-line test limit
 * after the #1929 cross-feature target fix added new H2/H4/H3-guard cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "@test/helpers";
import type { PostRunContext } from "@/plugins";
import type { Observation } from "@/plugins/builtin/curator";
import { curatorPlugin } from "@/plugins/builtin/curator";
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

  describe("H4 — Escalation Chain", () => {
    test("triggers for same tier path >= threshold; does not trigger for different paths", () => {
      const samePathObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "escalation",
          ts: "2026-05-04T00:00:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "escalation",
          ts: "2026-05-04T00:01:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
      ];
      const h4 = runHeuristics(samePathObs, { ...defaultThresholds, escalationChain: 2 }).find((p) => p.id === "H4");
      expect(h4).toBeDefined();
      expect(h4?.severity).toBe("MED");
      expect(h4?.target.action).toBe("add");

      const diffPathObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "escalation",
          ts: "2026-05-04T00:00:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-2",
          stage: "escalation",
          ts: "2026-05-04T00:01:00Z",
          kind: "escalation",
          payload: { from: "balanced", to: "powerful" },
        },
      ];
      expect(
        runHeuristics(diffPathObs, { ...defaultThresholds, escalationChain: 2 }).find((p) => p.id === "H4"),
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
          stage: "escalation",
          ts: "2026-05-04T00:00:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-billing",
          storyId: "story-2",
          stage: "escalation",
          ts: "2026-05-04T00:01:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feature-onboarding",
          storyId: "story-3",
          stage: "escalation",
          ts: "2026-05-04T00:02:00Z",
          kind: "escalation",
          payload: { from: "fast", to: "balanced" },
        },
      ];

      const h4 = runHeuristics(crossFeatureObs, { ...defaultThresholds, escalationChain: 2 }).find(
        (p) => p.id === "H4",
      );
      expect(h4).toBeDefined();
      expect(h4?.target.canonicalFile).toBe(".nax/rules/curator-suggestions.md");
      expect(h4?.target.canonicalFile).not.toContain("feature-context-fragments");
      expect(h4?.target.canonicalFile).not.toContain(".nax/features/");
      expect(h4?.evidence).toContain("feature-context-fragments");
      expect(h4?.evidence).toContain("feature-billing");
      expect(h4?.evidence).toContain("feature-onboarding");
    });
  });

  describe("H5 — Stale Chunk Excluded", () => {
    test("triggers for stale exclusions persisting across runs; does not trigger for non-stale", () => {
      // US-002: H5 fires on `payload.stale === true`. `reason` carries the
      // mechanical cause that excluded the chunk; staleness is an orthogonal
      // axis attributed by the manifest.
      const staleObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-04T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "stale chunk", reason: "budget", stale: true },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-2",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-05T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "stale chunk", reason: "budget", stale: true },
        },
      ];
      const h5 = runHeuristics(staleObs, { ...defaultThresholds, staleChunkRuns: 2 }).find((p) => p.id === "H5");
      expect(h5).toBeDefined();
      expect(h5?.severity).toBe("LOW");
      expect(h5?.target.action).toBe("drop");

      const noMatchObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-04T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "chunk", reason: "no-match" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-2",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "context",
          ts: "2026-05-05T00:00:00Z",
          kind: "chunk-excluded",
          payload: { chunkId: "c1", label: "chunk", reason: "no-match" },
        },
      ];
      expect(
        runHeuristics(noMatchObs, { ...defaultThresholds, staleChunkRuns: 2 }).find((p) => p.id === "H5"),
      ).toBeUndefined();
    });
  });

  describe("H6 — Fix-cycle Unchanged Outcome", () => {
    test("triggers when unchanged outcome >= threshold; does not trigger with mixed outcomes", () => {
      const unchangedObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:00:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 1, status: "failed", outcome: "unchanged" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:01:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 2, status: "failed", outcome: "unchanged" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:02:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 3, status: "failed", outcome: "unchanged" },
        },
      ];
      const h6 = runHeuristics(unchangedObs, { ...defaultThresholds, unchangedOutcome: 3 }).find((p) => p.id === "H6");
      expect(h6).toBeDefined();
      expect(h6?.severity).toBe("LOW");
      expect(h6?.target.action).toBe("advisory");

      const mixedObs: Observation[] = [
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:00:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 1, status: "passed", outcome: "resolved" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-1",
          storyId: "story-1",
          stage: "fix-cycle",
          ts: "2026-05-04T00:01:00Z",
          kind: "fix-cycle-iteration",
          payload: { iteration: 2, status: "failed", outcome: "unchanged" },
        },
      ];
      expect(
        runHeuristics(mixedObs, { ...defaultThresholds, unchangedOutcome: 2 }).find((p) => p.id === "H6"),
      ).toBeUndefined();
    });
  });

  describe("Multiple heuristics firing", () => {
    test("returns all triggered proposals together", () => {
      const obs: Observation[] = [
        // H1: Repeated finding
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
        // H2: Pull-tool empty
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-1",
          storyId: "story-1",
          stage: "pull",
          ts: "2026-05-04T00:02:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
        {
          schemaVersion: 1,
          projectKey: "test-proj",
          runId: "run-1",
          featureId: "feat-story-3",
          storyId: "story-3",
          stage: "pull",
          ts: "2026-05-04T00:03:00Z",
          kind: "pull-call",
          payload: { toolName: "query_feature_context", keyword: "review batch", resultCount: 0, status: "completed" },
        },
      ];

      const proposals = runHeuristics(obs, defaultThresholds);

      expect(proposals.length).toBeGreaterThanOrEqual(2);
      expect(proposals.some((p) => p.id === "H1")).toBe(true);
      expect(proposals.some((p) => p.id === "H2")).toBe(true);
    });
  });

  describe("Evidence and metadata", () => {
    test("includes observation kind in sourceKinds", () => {
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

      const proposals = runHeuristics(obs, defaultThresholds);
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1?.sourceKinds).toContain("review-finding");
    });

    test("produces non-empty description and evidence", () => {
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

      const proposals = runHeuristics(obs, defaultThresholds);
      const h1 = proposals.find((p) => p.id === "H1");

      expect(h1?.description).toMatch(/\S/);
      expect(h1?.evidence).toMatch(/\S/);
    });
  });
});

// ---------------------------------------------------------------------------
// Post-run size-gated auto-prune (US-004). Absorbed from
// curator-us-004-postrun.test.ts.
// ---------------------------------------------------------------------------

function makePostRunContext(opts: {
  outputDir: string;
  globalDir: string;
  curatorRollupPath: string;
  runId: string;
  projectKey: string;
}): { ctx: PostRunContext; warnCalls: Array<{ message: string; data?: Record<string, unknown> }> } {
  const warnCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const ctx: PostRunContext = {
    runId: opts.runId,
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
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, data?: Record<string, unknown>) => {
        warnCalls.push({ message, data });
      },
      error: () => {},
    },
    outputDir: opts.outputDir,
    globalDir: opts.globalDir,
    projectKey: opts.projectKey,
    curatorRollupPath: opts.curatorRollupPath,
  };
  return { ctx, warnCalls };
}

function makeObs(runId: string, projectKey: string, padding = ""): Observation {
  return {
    schemaVersion: 3,
    projectKey,
    runId,
    featureId: "feat-test",
    storyId: "US-001",
    stage: "review",
    ts: new Date(2026, 0, 1, 0, 0, 0).toISOString(),
    kind: "review-finding",
    payload: { ruleId: "rule-x", severity: "info", file: "src/a.ts", line: 1, message: padding },
  };
}

async function seedRunsAndRollup(opts: {
  outputDir: string;
  globalDir: string;
  rollupPath: string;
  projectKey: string;
  nRuns: number;
  padding?: string;
}): Promise<number> {
  await mkdir(opts.globalDir, { recursive: true });
  await mkdir(path.dirname(opts.rollupPath), { recursive: true });
  const padding = opts.padding ?? "x".repeat(2048);
  const lines: string[] = [];
  for (let i = 0; i < opts.nRuns; i += 1) {
    const runId = `run-${String(i).padStart(4, "0")}`;
    const obs = makeObs(runId, opts.projectKey, padding);
    lines.push(JSON.stringify(obs));

    const runDir = path.join(opts.outputDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "observations.jsonl"), `${JSON.stringify(obs)}\n`);
    await writeFile(path.join(runDir, "curator-proposals.md"), `# Proposals for ${runId}\n`);
  }
  await writeFile(opts.rollupPath, `${lines.join("\n")}\n`);
  return Bun.file(opts.rollupPath).size;
}

type ScanAndPruneCall = {
  rollupPath: string;
  projectKey: string;
  keepRuns: number;
};

describe("curator post-run action — size-gated auto-prune (US-004)", () => {
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

  test("AC8: outputDir set + over-threshold rollup → pruneRollup invoked once", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns: 3 });
      const { ctx } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size - 1, keepRuns: 2 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      expect(action).toBeDefined();
      await action?.execute(ctx);

      expect(scanAndPruneCalls).toHaveLength(1);
      expect(scanAndPruneCalls[0]?.rollupPath).toBe(rollupPath);
      expect(scanAndPruneCalls[0]?.projectKey).toBe(projectKey);
    });
  });

  test("AC9: outputDir set + under-threshold rollup → pruneRollup is NOT invoked", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns: 3 });

      const { ctx } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size + 4096, keepRuns: 2 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      await action?.execute(ctx);

      expect(scanAndPruneCalls).toHaveLength(0);
    });
  });

  test("AC10: outputDir set + pruneRollup rejects → success remains true AND a pruning-related logger.warn fires", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns: 3 });

      _curatorPruneDeps.scanAndPruneNewest = (async () => {
        throw new Error("disk full");
      }) as typeof _curatorPruneDeps.scanAndPruneNewest;

      const { ctx, warnCalls } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size - 1, keepRuns: 2 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      const result = await action?.execute(ctx);

      expect(result?.success).toBe(true);
      const pruneWarn = warnCalls.find((call) => /prune/i.test(call.message));
      expect(pruneWarn).toBeDefined();
    });
  });

  test("AC11: outputDir set + over-threshold prune evicts runs → evicted run dirs preserve observations.jsonl and curator-proposals.md", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const nRuns = 3;
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns });

      _curatorPruneDeps.scanAndPruneNewest = (async (rollupPathArg: string, _projectKey: string, keepRuns: number) => {
        const allRunIds: string[] = [];
        for (let i = 0; i < nRuns; i += 1) allRunIds.push(`run-${String(i).padStart(4, "0")}`);
        const keepRunIds = new Set(allRunIds.slice(0, keepRuns));
        const evicted = allRunIds.filter((id) => !keepRunIds.has(id));
        const dropped = evicted.length;
        const remaining = [...keepRunIds];
        const lines = remaining.map((runId) => JSON.stringify(makeObs(runId, projectKey)));
        await writeFile(rollupPathArg, `${lines.join("\n")}\n`);
        return {
          kept: remaining.length,
          dropped,
          keptOtherProjects: 0,
          keptUnattributed: 0,
        } satisfies PruneResult;
      }) as typeof _curatorPruneDeps.scanAndPruneNewest;

      const { ctx } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size - 1, keepRuns: 1 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      await action?.execute(ctx);

      const after = await Bun.file(rollupPath).text();
      const survivingRunIds = after
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line).runId);
      expect(survivingRunIds.length).toBe(1);

      const allRunIds: string[] = [];
      for (let i = 0; i < nRuns; i += 1) allRunIds.push(`run-${String(i).padStart(4, "0")}`);
      const evicted = allRunIds.filter((id) => !survivingRunIds.includes(id));
      expect(evicted.length).toBeGreaterThan(0);

      for (const runId of evicted) {
        const runDir = path.join(outputDir, "runs", runId);
        expect(await Bun.file(path.join(runDir, "observations.jsonl")).exists()).toBe(true);
        expect(await Bun.file(path.join(runDir, "curator-proposals.md")).exists()).toBe(true);
      }
    });
  });
});
