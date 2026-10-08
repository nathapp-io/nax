/**
 * The rectify-cycle observation (curator H3) is built from the rectification
 * loop's real per-cycle summary line.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

async function runWithLogEntries(entries: Record<string, unknown>[]) {
  const root = await mkdtemp(join(tmpdir(), "curator-rectify-"));
  const logFilePath = join(root, "run.jsonl");
  await writeFile(logFilePath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const context: CuratorPostRunContext = {
    runId: "run-rectify",
    feature: "feat-rectify",
    workdir: root,
    prdPath: join(root, ".nax", "features", "feat-rectify", "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 0,
    storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: makeNaxConfig(),
    outputDir: join(root, "out"),
    globalDir: join(root, "global"),
    projectKey: "test-project-rectify",
    curatorRollupPath: join(root, "rollup.jsonl"),
    logFilePath,
  };
  return collectObservations(context);
}

const summary = (message: string, data: Record<string, unknown>) => ({
  timestamp: "2026-10-08T00:00:00.000Z",
  level: "warn",
  stage: "story-orchestrator",
  message,
  storyId: "US-001",
  data: { storyId: "US-001", initialFindingsCount: 2, finalFindingsCount: 1, costUsd: 0.4, ...data },
});

describe("collectObservations — rectify-cycle observations", () => {
  test("each rectification cycle summary yields one rectify-cycle observation", async () => {
    const observations = await runWithLogEntries([
      summary("Rectification exited: max-attempts-per-strategy", {
        iterationCount: 3,
        exitReason: "max-attempts-per-strategy",
      }),
      summary("Rectification resolved all findings", { iterationCount: 1, exitReason: "resolved" }),
    ]);
    const cycles = observations.filter((o) => o.kind === "rectify-cycle");
    expect(cycles.map((o) => o.payload)).toEqual([
      { iteration: 3, status: "failed" },
      { iteration: 1, status: "passed" },
    ]);
    expect(cycles.every((o) => o.storyId === "US-001" && o.stage === "rectify")).toBe(true);
  });

  test("other story-orchestrator lines are not rectify cycles", async () => {
    const observations = await runWithLogEntries([
      {
        timestamp: "2026-10-08T00:00:00.000Z",
        level: "info",
        stage: "story-orchestrator",
        message: "Rectification strategy completed: autofix",
        data: { storyId: "US-001", phase: "autofix" },
      },
    ]);
    expect(observations.filter((o) => o.kind === "rectify-cycle")).toEqual([]);
  });
});
