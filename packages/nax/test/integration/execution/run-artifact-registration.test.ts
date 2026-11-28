/**
 * US-003 — registry metadata records the actual log basename and the run start instant.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSequentialExecutionContext,
  makeStory,
  makeTempDir,
  waitForFile,
} from "@test/helpers";
import { globalConfigDir } from "@/config/paths";
import { _runnerDeps, _runnerReentrancyGuard } from "@/execution";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { buildRunId } from "@/execution/run-id";
import { executeUnified } from "@/execution/unified-executor";
import { getSafeLogger, resetLogger } from "@/logger";
import { PipelineEventEmitter } from "@/pipeline/events";
import type { MetaJson } from "@/pipeline/subscribers/registry";
// biome-ignore lint/style/noRestrictedImports: CLI entry helpers live in bin/, outside the @/ source alias.
import { initRunLogging } from "../../../bin/run-action";
// biome-ignore lint/style/noRestrictedImports: CLI entry helpers live in bin/, outside the @/ source alias.
import { executeSingleAgentRun } from "../../../bin/run-action-execute";

describe("registry metadata for a run", () => {
  let out: string;
  let metaFile: string;
  const runId = "run-reg-1";
  beforeEach(() => {
    out = makeTempDir("run-artifact-reg-");
    metaFile = join(globalConfigDir(), "runs", `${out.split("/").pop()}-feat-${runId}`, "meta.json");
  });
  afterEach(async () => {
    await rm(join(metaFile, ".."), { recursive: true, force: true });
    cleanupTempDir(out);
  });

  test("AC-2/AC-13: executeUnified registers the basename and ctx.startTime, not delivery time", async () => {
    const feature = "feat";
    const startTime = Date.parse("2020-05-05T05:05:05.005Z");
    const logFilePath = join(out, ".nax", "features", feature, "runs", "custom-name.jsonl");
    const config = makeNaxConfig({ execution: { iterationDelayMs: 0, mode: "workflow" } });
    const runtime = makeMockRuntime({ config, workdir: out });
    const prd = makePRD({
      feature,
      userStories: [makeStory({ id: "US-1", status: "passed", passes: true })],
    });
    const ctx = makeSequentialExecutionContext({
      ...makeDispatchContext({ runtime }),
      config,
      workdir: out,
      feature,
      pluginRegistry: makePluginRegistry(),
      runId,
      startTime,
      logFilePath,
    });
    try {
      await executeUnified(ctx, prd);
      await waitForFile(metaFile, 2000);
      const meta: MetaJson = JSON.parse(await readFile(metaFile, "utf8"));
      expect(meta.logFileName).toBe("custom-name.jsonl");
      expect(meta.registeredAt).toBe("2020-05-05T05:05:05.005Z");
    } finally {
      stopHeartbeat();
    }
  });

  test("AC-1: real setup keeps the logger-time runId and writes it to run.start", async () => {
    const setup = new Date("2026-11-28T10:00:00.123Z");
    setSystemTime(setup);
    resetLogger();
    let logged: ReturnType<typeof initRunLogging>;
    try {
      logged = initRunLogging({
        options: { feature: "feat", headless: true, dryRun: true, dir: out },
        config: makeNaxConfig({ outputDir: out }),
        workdir: out,
        isTTY: false,
        logLevel: "info",
        formatterMode: "normal",
      });
    } finally {
      // Clock moves on after logger initialization; the runner must not rebuild the id.
      setSystemTime(new Date("2026-11-28T10:05:00.999Z"));
    }
    const expectedId = buildRunId(out, setup);
    expect(logged.runId).toBe(expectedId);
    expect(logged.logFilePath.endsWith(`${expectedId}.jsonl`)).toBe(true);

    const featureDir = join(out, ".nax", "features", "feat");
    const prdPath = join(featureDir, "prd.json");
    await mkdir(featureDir, { recursive: true });
    await writeFile(
      prdPath,
      JSON.stringify(makePRD({ feature: "feat", userStories: [makeStory({ id: "US-1", status: "pending" })] })),
    );
    const orig = { ..._runnerDeps };
    _runnerReentrancyGuard.inFlight = false;
    _runnerDeps.runExecutionPhase = async () => {
      throw new Error("stop after setup");
    };
    try {
      await executeSingleAgentRun({
        options: { feature: "feat", dir: out, dryRun: true, batch: false, skipPrecheck: true, headless: true },
        config: makeNaxConfig({ outputDir: out }),
        hooks: { hooks: {}, _skipGlobal: false },
        prdPath,
        workdir: out,
        featureDir,
        eventEmitter: new PipelineEventEmitter(),
        statusFilePath: join(out, "status.json"),
        logFilePath: logged.logFilePath,
        runId: logged.runId,
        formatterMode: "quiet",
        useHeadless: false,
        agentStreamEvents: undefined,
        tuiInstance: undefined,
      }).catch(() => {});
      await getSafeLogger()?.flush();
    } finally {
      Object.assign(_runnerDeps, orig);
      _runnerReentrancyGuard.inFlight = false;
      setSystemTime();
    }
    const lines = (await readFile(logged.logFilePath, "utf8")).split("\n").filter(Boolean);
    const start = lines.map((l) => JSON.parse(l)).find((e) => e.stage === "run.start");
    expect(start?.data?.runId).toBe(expectedId);
    resetLogger();
  });
});
