/**
 * US-003 — registry metadata records the actual log basename and the run start instant.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
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
import { _runnerDeps, _runnerReentrancyGuard, run } from "@/execution";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { buildRunId } from "@/execution/run-id";
import { executeUnified } from "@/execution/unified-executor";
import { resetLogger } from "@/logger";
import type { MetaJson } from "@/pipeline/subscribers/registry";
// biome-ignore lint/style/noRestrictedImports: CLI entry helpers live in bin/, outside the @/ source alias.
import { initRunLogging } from "../../../bin/run-action";

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

  test("AC-1: run() receives the logger-setup runId, which setup writes to run.start", async () => {
    const setup = new Date("2026-11-28T10:00:00.123Z");
    setSystemTime(setup);
    let logged: ReturnType<typeof initRunLogging>;
    try {
      resetLogger();
      logged = initRunLogging({
        options: { feature: "feat", headless: true, dryRun: false, dir: out },
        config: makeNaxConfig({ outputDir: out }),
        workdir: out,
        isTTY: false,
        logLevel: "info",
        formatterMode: "normal",
      });
    } finally {
      setSystemTime();
      resetLogger();
    }
    expect(logged.runId).toBe(buildRunId(out, setup));
    expect(logged.runId).toMatch(/\.123$/);
    expect(logged.logFilePath.endsWith(`${logged.runId}.jsonl`)).toBe(true);

    // Clock has moved on; the runner must keep the supplied id rather than rebuild it.
    const orig = { ..._runnerDeps };
    let seen: string | undefined;
    _runnerReentrancyGuard.inFlight = false;
    _runnerDeps.runSetupPhase = (async (o: { runId?: string }) => {
      seen = o.runId;
      throw new Error("stop after setup");
    }) as typeof _runnerDeps.runSetupPhase;
    try {
      await run({
        prdPath: join(out, "prd.json"),
        workdir: out,
        config: makeNaxConfig(),
        hooks: { hooks: {}, _skipGlobal: false },
        feature: "feat",
        featureDir: join(out, ".nax", "features", "feat"),
        dryRun: false,
        useBatch: false,
        statusFile: join(out, "status.json"),
        logFilePath: logged.logFilePath,
        runId: logged.runId,
        formatterMode: "quiet",
        headless: false,
        skipPrecheck: true,
      }).catch(() => {});
    } finally {
      Object.assign(_runnerDeps, orig);
      _runnerReentrancyGuard.inFlight = false;
    }
    expect(seen).toBe(buildRunId(out, setup));
  });
});
