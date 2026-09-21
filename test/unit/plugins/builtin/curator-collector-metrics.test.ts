/**
 * Curator metrics reader fails closed (US-006)
 *
 * `metrics.json` is a project-level append shared by every feature (locked
 * through `withPathFileLock` in `src/metrics/tracker.ts`), so entries belonging
 * to OTHER runs coexist with this run's. The reader must match on `runId` and
 * return nothing — plus a warn — when no entry matches; the positional
 * `runs.at(-1)` fallback attributed another feature's stories to this run.
 *
 * AC1 — no `runId` match → no metrics-derived observations.
 * AC2 — no `runId` match → warn on the curator logger naming the runId.
 * AC3 — `runId` match → that entry's story observations.
 * AC4 — two distinct runIds present, context names one → every observation
 *       carries the named entry's runId (and none of the other's stories).
 * Plus the preserved corrupt-file skip behaviour (story Scope).
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

interface WarnCall {
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Build a context whose logger records warn calls — the same capture shape the
 * curator post-run tests use, so AC2 is asserted against the collaborator the
 * collector actually holds (`context.logger`, a `PluginLogger`).
 */
function makeContext(opts: { root: string; runId: string; outputDir: string }): {
  context: CuratorPostRunContext;
  warnCalls: WarnCall[];
} {
  const warnCalls: WarnCall[] = [];
  const workdir = join(opts.root, "work");
  const context: CuratorPostRunContext = {
    runId: opts.runId,
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
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, data?: Record<string, unknown>) => {
        warnCalls.push({ message, data });
      },
      error: () => {},
    },
    config: makeNaxConfig(),
    outputDir: opts.outputDir,
    globalDir: join(opts.root, "global"),
    projectKey: "test-project",
    curatorRollupPath: join(opts.root, "rollup.jsonl"),
  };
  return { context, warnCalls };
}

/** One metrics.json run entry carrying `count` stories. */
function makeRunEntry(runId: string, feature: string, storyIds: string[]): Record<string, unknown> {
  return {
    runId,
    feature,
    stories: storyIds.map((storyId) => ({
      storyId,
      success: true,
      attempts: 1,
      cost: 0.5,
      source: "execution",
      tokens: { inputTokens: 10, outputTokens: 5 },
    })),
  };
}

async function writeMetrics(outputDir: string, runs: unknown[]): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "metrics.json"), JSON.stringify(runs));
}

describe("collectObservations — metrics reader fails closed (US-006)", () => {
  test("AC1: returns no metrics-derived observations when no entry matches context.runId", async () => {
    await withTempDir(async (dir) => {
      const outputDir = join(dir, "out");
      // The only entry belongs to another run — the old positional fallback
      // would have attributed US-OTHER to this run's observations.
      await writeMetrics(outputDir, [makeRunEntry("run-other", "feat-other", ["US-OTHER"])]);

      const { context } = makeContext({ root: dir, runId: "run-mine", outputDir });
      const observations = await collectObservations(context);

      expect(observations.filter((o) => o.kind === "verdict")).toHaveLength(0);
      expect(observations.some((o) => o.storyId === "US-OTHER")).toBe(false);
    });
  });

  test("AC2: warns on the curator logger, naming the runId, when no entry matches", async () => {
    await withTempDir(async (dir) => {
      const outputDir = join(dir, "out");
      await writeMetrics(outputDir, [
        makeRunEntry("run-other", "feat-other", ["US-OTHER"]),
        makeRunEntry("run-elsewhere", "feat-elsewhere", ["US-ELSEWHERE"]),
      ]);

      const { context, warnCalls } = makeContext({ root: dir, runId: "run-mine", outputDir });
      await collectObservations(context);

      const warn = warnCalls.find((call) => call.data?.runId === "run-mine");
      expect(warn).toBeDefined();
      expect(warn?.message).toContain("metrics.json");
      // The entry count is what tells an operator the file did hold runs —
      // just none of them this one.
      expect(warn?.data?.runCount).toBe(2);
    });
  });

  test("AC3: returns the matching run's story observations when runId matches", async () => {
    await withTempDir(async (dir) => {
      const outputDir = join(dir, "out");
      await writeMetrics(outputDir, [makeRunEntry("run-mine", "feat-mine", ["US-001", "US-002"])]);

      const { context, warnCalls } = makeContext({ root: dir, runId: "run-mine", outputDir });
      const observations = await collectObservations(context);

      const verdicts = observations.filter((o) => o.kind === "verdict");
      expect(verdicts.map((o) => o.storyId).sort()).toEqual(["US-001", "US-002"]);
      expect(verdicts.every((o) => o.runId === "run-mine")).toBe(true);
      expect(verdicts.every((o) => o.featureId === "feat-mine")).toBe(true);
      expect(warnCalls).toHaveLength(0);
    });
  });

  test("AC4: with two runIds present, every observation comes from the entry the context names", async () => {
    await withTempDir(async (dir) => {
      const outputDir = join(dir, "out");
      // Chronologically the OTHER run is last — precisely the entry the
      // removed positional fallback would have selected.
      await writeMetrics(outputDir, [
        makeRunEntry("run-mine", "feat-mine", ["US-001", "US-002"]),
        makeRunEntry("run-other", "feat-other", ["US-900", "US-901", "US-902"]),
      ]);

      const { context } = makeContext({ root: dir, runId: "run-mine", outputDir });
      const observations = await collectObservations(context);

      expect(observations.length).toBeGreaterThan(0);
      // Every returned observation carries the named entry's runId...
      expect(observations.every((o) => o.runId === "run-mine")).toBe(true);
      // ...and the named entry's stories, not the other run's.
      const storyIds = observations.map((o) => o.storyId);
      expect(storyIds).toEqual(["US-001", "US-002"]);
      expect(observations.some((o) => o.featureId === "feat-other")).toBe(false);
    });
  });

  test("preserved: a corrupt metrics.json is skipped without breaking the other sources", async () => {
    await withTempDir(async (dir) => {
      const outputDir = join(dir, "out");
      const auditDir = join(outputDir, "review-audit", "feat-auth");
      await mkdir(auditDir, { recursive: true });
      await writeFile(join(outputDir, "metrics.json"), "{ not valid json");
      await writeFile(
        join(auditDir, "1-review.json"),
        JSON.stringify({
          timestamp: "2026-05-04T00:00:00.000Z",
          storyId: "US-001",
          featureName: "feat-auth",
          result: { findings: [{ rule: "no-n-plus-one", severity: "error", file: "src/api.ts", line: 42 }] },
        }),
      );

      const { context } = makeContext({ root: dir, runId: "run-mine", outputDir });
      const observations = await collectObservations(context);

      const verdicts = observations.filter((o) => o.kind === "verdict");
      expect(verdicts).toHaveLength(0);
      expect(observations.some((o) => o.kind === "review-finding" && o.payload.ruleId === "no-n-plus-one")).toBe(true);
    });
  });
});
