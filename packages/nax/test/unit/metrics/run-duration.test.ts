import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { RunMetrics } from "@/metrics";
import { loadRunMetrics, saveRunMetrics, updateRunMetricsDuration } from "@/metrics";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const run = (runId: string, totalDurationMs: number): RunMetrics => ({
  runId,
  feature: "f",
  startedAt: "t0",
  completedAt: "t1",
  totalCost: 1,
  totalStories: 1,
  storiesCompleted: 1,
  storiesFailed: 0,
  totalDurationMs,
  stories: [],
});

describe("updateRunMetricsDuration", () => {
  test("rewrites only the named run with the whole-run duration and both parts", async () => {
    const dir = makeTempDir("metrics-dur-");
    dirs.push(dir);
    await saveRunMetrics(dir, run("r1", 10));
    await saveRunMetrics(dir, run("r2", 20));
    const ok = await updateRunMetricsDuration(dir, "r2", {
      totalDurationMs: 30,
      storiesDurationMs: 20,
      featureWorkflowDurationMs: 10,
      totalCost: 4.25,
      completedAt: "t2",
    });
    expect(ok).toBe(true);
    const runs = await loadRunMetrics(dir);
    expect(runs[0]?.totalDurationMs).toBe(10);
    expect(runs[1]).toMatchObject({
      totalDurationMs: 30,
      storiesDurationMs: 20,
      featureWorkflowDurationMs: 10,
      totalCost: 4.25,
      completedAt: "t2",
    });
  });

  test("an unknown run is left alone and reported as not updated", async () => {
    const dir = makeTempDir("metrics-dur-none-");
    dirs.push(dir);
    await saveRunMetrics(dir, run("r1", 10));
    const ok = await updateRunMetricsDuration(dir, "nope", {
      totalDurationMs: 1,
      storiesDurationMs: 1,
      featureWorkflowDurationMs: 0,
      totalCost: 0,
      completedAt: "t",
    });
    expect(ok).toBe(false);
    expect((await loadRunMetrics(dir))[0]?.totalDurationMs).toBe(10);
  });
});
