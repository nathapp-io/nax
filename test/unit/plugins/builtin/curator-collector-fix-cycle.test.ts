/**
 * #1948 — fix-cycle iteration spend reaching the curator's observation corpus.
 *
 * Split out of curator-collector.test.ts, which is at its size baseline.
 *
 * Part A's whole purpose is that the magnitude Part B needs survives as far as
 * the corpus, distinguishable from successful spend. The producing half of the
 * chain is pinned in test/unit/findings/cycle-cost.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

describe("collectObservations — fix-cycle iteration spend (#1948)", () => {
  /** Write one `iteration completed` log entry and collect what it produces. */
  async function collectFromIterationLog(root: string, data: Record<string, unknown>) {
    const logFilePath = join(root, "run.jsonl");
    await writeFile(
      logFilePath,
      `${JSON.stringify({
        timestamp: "2026-05-04T00:03:00.000Z",
        level: "info",
        stage: "findings.cycle",
        message: "iteration completed",
        data,
      })}\n`,
    );
    const context: CuratorPostRunContext = {
      runId: "run-fix-cycle-spend",
      feature: "feat-auth",
      workdir: root,
      prdPath: join(root, ".nax", "features", "feat-auth", "prd.json"),
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: makeNaxConfig(),
      outputDir: join(root, "out"),
      globalDir: join(root, "global"),
      projectKey: "test-project",
      curatorRollupPath: join(root, "rollup.jsonl"),
      logFilePath,
    };
    const observations = await collectObservations(context);
    return observations.find((o) => o.kind === "fix-cycle-iteration");
  }

  const baseIteration = {
    storyId: "US-001",
    cycleName: "acceptance",
    iterationNum: 1,
    outcome: "unchanged",
    findingsBefore: 1,
    findingsAfter: 1,
  };

  test("failed-dispatch spend reaches the observation as its own field", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-fix-cycle-error-cost-"));

    const obs = await collectFromIterationLog(root, { ...baseIteration, costUsd: 0.5, errorCostUsd: 3.25 });

    expect(obs?.kind).toBe("fix-cycle-iteration");
    if (obs?.kind === "fix-cycle-iteration") {
      expect(obs.payload.costUsd).toBeCloseTo(0.5, 5);
      expect(obs.payload.errorCostUsd).toBeCloseTo(3.25, 5);
    }
  });

  test("an iteration log written before the field existed reports zero, not undefined", async () => {
    // Mirrors how `costUsd` already falls back, so older records read as "no
    // failed spend" rather than as a hole in the corpus.
    const root = await mkdtemp(join(tmpdir(), "curator-fix-cycle-error-cost-legacy-"));

    const obs = await collectFromIterationLog(root, baseIteration);

    expect(obs?.kind).toBe("fix-cycle-iteration");
    if (obs?.kind === "fix-cycle-iteration") {
      expect(obs.payload.errorCostUsd).toBe(0);
    }
  });
});
