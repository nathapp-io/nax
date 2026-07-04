import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Command } from "commander";

import {
  inferPhases,
  reconstructTimeline,
  discoverRun,
  renderReport,
  toReplayJson,
  registerReplayCommand,
  runReplay,
} from "@/replay";
import { _discoveryDeps } from "../../../src/replay/discovery";
import { _replayDeps } from "../../../src/commands/replay";
import { NaxError } from "@/errors";
import { makeTempDir, cleanupTempDir } from "@test/helpers";
import type { LogEntry } from "@/logger/types";
import type { RunMetrics, StoryMetrics } from "@/metrics/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY_ID = "US-002";

function makeLogEntry(overrides: Partial<Record<string, unknown>> = {}): LogEntry {
  return {
    timestamp: "2026-07-04T10:00:00.000Z",
    level: "info",
    stage: "story-orchestrator",
    message: "Phase passed: implementer",
    ...overrides,
  } as LogEntry;
}

function makeStoryMetrics(overrides: Partial<StoryMetrics> & { storyId: string }): StoryMetrics {
  return {
    storyId: overrides.storyId,
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4-6",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.01,
    durationMs: 5000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:05Z",
    ...overrides,
  } as StoryMetrics;
}

function makeRunMetrics(
  stories: StoryMetrics[],
  overrides: Partial<RunMetrics> = {},
): RunMetrics {
  return {
    runId: "run-2026-07-04T10-51-37-987Z",
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:01:00Z",
    totalCost: stories.reduce((s, m) => s + (m.cost ?? 0), 0),
    totalStories: stories.length,
    storiesCompleted: stories.filter((s) => s.success).length,
    storiesFailed: stories.filter((s) => !s.success).length,
    totalDurationMs: 60000,
    stories,
    ...overrides,
  } as RunMetrics;
}

function makePassedStory(id: string, phases: unknown[] = []): unknown {
  return { storyId: id, status: "passed", phases, cost: 0.1, finalTier: "balanced", attempts: 1 };
}

function makeFailedStory(id: string, phases: unknown[] = []): unknown {
  return { storyId: id, status: "failed", phases, cost: 0.2, finalTier: "balanced", attempts: 2 };
}

function makeTimeline(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "run-abc",
    feature: "my-feature",
    status: "failed",
    inferred: true,
    naxVersion: "0.71.1",
    stories: [],
    cost: 0.05,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// US-001: inferPhases
// ---------------------------------------------------------------------------

describe("US-001 inferPhases", () => {
  test("AC-1: inferPhases importable as function with arity 2", () => {
    expect(typeof inferPhases).toBe("function");
    expect(inferPhases.length).toBe(2);
  });

  test("AC-2: single passing phase returns array with correct name and status", () => {
    const entries = [
      makeLogEntry({ stage: "story-orchestrator", message: "Phase passed: implementer", data: { storyId: STORY_ID } }),
    ];
    const result = inferPhases(entries, STORY_ID);
    expect(result[0].name).toBe("implementer");
    expect(result[0].status).toBe("pass");
    expect(result.length).toBe(1);
  });

  test("AC-3: multiple passing phases preserve chronological order", () => {
    const entries = [
      makeLogEntry({ message: "Phase passed: test-writer", data: { storyId: STORY_ID } }),
      makeLogEntry({ message: "Phase passed: implementer", data: { storyId: STORY_ID } }),
    ];
    const result = inferPhases(entries, STORY_ID);
    expect(result.map((p: { name: string }) => p.name)).toEqual(["test-writer", "implementer"]);
    expect(result.length).toBe(2);
  });

  test("AC-4: failed phase entry has status fail", () => {
    const entries = [
      makeLogEntry({ message: "Phase failed: full-suite-gate", data: { storyId: STORY_ID } }),
    ];
    const result = inferPhases(entries, STORY_ID);
    expect(result.some((p: { name: string; status: string }) => p.name === "full-suite-gate" && p.status === "fail")).toBe(true);
  });

  test("AC-5: fail-stale entry produces non-empty escalations list", () => {
    const entries = [
      makeLogEntry({
        stage: "agent-manager",
        message: "fail-stale: immediate same-agent retry",
        data: { storyId: STORY_ID },
      }),
    ];
    const result = inferPhases(entries, STORY_ID);
    expect(result.escalations).toBeDefined();
    expect(Array.isArray(result.escalations)).toBe(true);
    expect((result.escalations as unknown[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// US-001: reconstructTimeline
// ---------------------------------------------------------------------------

describe("US-001 reconstructTimeline", () => {
  test("AC-6: reconstructTimeline importable with arity >= 2", () => {
    expect(typeof reconstructTimeline).toBe("function");
    expect(reconstructTimeline.length).toBeGreaterThanOrEqual(2);
  });

  test("AC-7: returns RunTimeline with runId, feature, and matching stories length", () => {
    const stories = [
      makeStoryMetrics({ storyId: "US-001" }),
      makeStoryMetrics({ storyId: "US-002" }),
      makeStoryMetrics({ storyId: "US-003" }),
    ];
    const runMetrics = makeRunMetrics(stories);
    const logSpine = [makeLogEntry({ stage: "run.start", message: "started", data: { runId: runMetrics.runId, naxVersion: "0.71.1" } })];
    const registry = { runId: runMetrics.runId, feature: runMetrics.feature };
    const result = reconstructTimeline(logSpine, runMetrics, registry);
    expect(result.runId).toBe(runMetrics.runId);
    expect(result.feature).toBe(registry.feature);
    expect(result.stories.length).toBe(stories.length);
  });

  test("AC-8: story timeline enriched from StoryMetrics", () => {
    const storyMetrics = makeStoryMetrics({ storyId: STORY_ID, success: true, finalTier: "balanced", cost: 0.42, attempts: 2 });
    const runMetrics = makeRunMetrics([storyMetrics]);
    const logSpine = [makeLogEntry({ stage: "run.start", message: "started", data: { runId: runMetrics.runId } })];
    const registry = { runId: runMetrics.runId, feature: "f" };
    const result = reconstructTimeline(logSpine, runMetrics, registry);
    const story = result.stories.find((s: { storyId: string }) => s.storyId === STORY_ID) as Record<string, unknown>;
    expect(story).toBeDefined();
    expect(story!.status).toBe("passed");
    expect(story!.finalTier).toBe("balanced");
    expect(story!.cost).toBe(0.42);
    expect(story!.attempts).toBe(2);
  });

  test("AC-9: null metrics with crash signal returns status crashed and undefined costs", () => {
    const logSpine = [
      makeLogEntry({ stage: "run.start", message: "started", data: { runId: "run-crash" } }),
      makeLogEntry({ stage: "run.crash", message: "process crashed", data: { exitCode: 1 } }),
    ];
    const result = reconstructTimeline(logSpine, null, null as any);
    expect(result.status).toBe("crashed");
    expect(result.stories.every((s: { cost: unknown }) => s.cost === undefined)).toBe(true);
  });

  test("AC-10: rootCausePhaseIndex is 0-indexed position of last failed phase", () => {
    const storyMetrics = makeStoryMetrics({ storyId: STORY_ID, success: false, finalTier: "balanced" });
    const runMetrics = makeRunMetrics([storyMetrics]);
    const logSpine = [
      makeLogEntry({ stage: "run.start", message: "started", data: { runId: runMetrics.runId } }),
      makeLogEntry({ message: "Phase passed: test-writer", data: { storyId: STORY_ID } }),
      makeLogEntry({ message: "Phase passed: implementer", data: { storyId: STORY_ID } }),
      makeLogEntry({ message: "Phase failed: full-suite-gate", data: { storyId: STORY_ID } }),
    ];
    const registry = { runId: runMetrics.runId, feature: "f" };
    const result = reconstructTimeline(logSpine, runMetrics, registry);
    const story = result.stories.find((s: { storyId: string }) => s.storyId === STORY_ID) as Record<string, unknown>;
    expect(story).toBeDefined();
    expect(story!.rootCausePhaseIndex).toBe(2);
  });

  test("AC-11: returned RunTimeline has inferred === true", () => {
    const runMetrics = makeRunMetrics([makeStoryMetrics({ storyId: "US-001" })]);
    const logSpine = [makeLogEntry({ stage: "run.start", message: "started", data: { runId: runMetrics.runId } })];
    const result = reconstructTimeline(logSpine, runMetrics, { runId: runMetrics.runId, feature: "f" });
    expect(result.inferred).toBe(true);
  });

  test("AC-12: naxVersion read from run.start log entry", () => {
    const runMetrics = makeRunMetrics([makeStoryMetrics({ storyId: "US-001" })]);
    const logSpine = [makeLogEntry({ stage: "run.start", message: "started", data: { naxVersion: "0.71.1", runId: runMetrics.runId } })];
    const result = reconstructTimeline(logSpine, runMetrics, { runId: runMetrics.runId, feature: "f" });
    expect(result.naxVersion).toBe("0.71.1");
  });
});

// ---------------------------------------------------------------------------
// US-002: discoverRun
// ---------------------------------------------------------------------------

describe("US-002 discoverRun", () => {
  let tempDir: string;
  let origGetRunsDir: typeof _discoveryDeps.getRunsDir;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    origGetRunsDir = _discoveryDeps.getRunsDir;
    _discoveryDeps.getRunsDir = () => tempDir;
  });

  afterEach(async () => {
    _discoveryDeps.getRunsDir = origGetRunsDir;
    await cleanupTempDir(tempDir);
  });

  async function writeRunMeta(runId: string, meta: Record<string, unknown>): Promise<void> {
    const dir = join(tempDir, runId);
    await Bun.write(join(dir, "meta.json"), JSON.stringify({ runId, ...meta }));
  }

  test("AC-13: discoverRun importable as function", () => {
    expect(typeof discoverRun).toBe("function");
  });

  test("AC-14: discoverRun resolves exact runId; meta.feature correct; jsonlPath ends in .jsonl", async () => {
    const RUN_ID = "run-2026-07-04T10-51-37-987Z";
    const eventsDir = join(tempDir, RUN_ID, "events");
    await writeRunMeta(RUN_ID, {
      feature: "my-feature",
      project: "proj",
      workdir: "/tmp",
      statusPath: join(tempDir, RUN_ID, "status.json"),
      eventsDir,
      registeredAt: "2026-07-04T10:51:37.987Z",
    });
    const result = await discoverRun(RUN_ID);
    expect(result.meta.feature).toBe("my-feature");
    expect(result.jsonlPath.endsWith(".jsonl")).toBe(true);
  });

  test("AC-15: discoverRun prefix-matches runId", async () => {
    const RUN_ID = "run-2026-07-04T10-51-37-987Z";
    await writeRunMeta(RUN_ID, {
      feature: "f",
      project: "p",
      workdir: "/tmp",
      statusPath: join(tempDir, RUN_ID, "status.json"),
      eventsDir: join(tempDir, RUN_ID, "events"),
      registeredAt: "2026-07-04T10:51:37.987Z",
    });
    const result = await discoverRun("run-2026-07-04");
    expect(result.meta.runId).toBe(RUN_ID);
  });

  test("AC-16: discoverRun with no argument selects lexicographically greatest runId", async () => {
    const RUN_A = "run-2026-07-04T10-51-37-987Z";
    const RUN_B = "run-2026-08-04T10-51-37-987Z";
    for (const runId of [RUN_A, RUN_B]) {
      await writeRunMeta(runId, {
        feature: "f",
        project: "p",
        workdir: "/tmp",
        statusPath: join(tempDir, runId, "status.json"),
        eventsDir: join(tempDir, runId, "events"),
        registeredAt: "2026-07-04T10:00:00.000Z",
      });
    }
    const result = await discoverRun();
    expect(result.meta.runId).toBe(RUN_B);
  });

  test("AC-17: discoverRun throws NaxError RUN_NOT_FOUND for unknown runId", async () => {
    let caught: unknown;
    try {
      await discoverRun("nonexistent-run");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("RUN_NOT_FOUND");
  });

  test("AC-18: discoverRun throws NaxError RUN_NOT_FOUND when prefix matches multiple runs", async () => {
    for (const runId of ["run-2026-07-04T10-51-37-987Z", "run-2026-07-05T10-51-37-987Z"]) {
      await writeRunMeta(runId, {
        feature: "f",
        project: "p",
        workdir: "/tmp",
        statusPath: join(tempDir, runId, "status.json"),
        eventsDir: join(tempDir, runId, "events"),
        registeredAt: "2026-07-04T10:00:00.000Z",
      });
    }
    let caught: unknown;
    try {
      await discoverRun("run-2026-07");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect((caught as NaxError).code).toBe("RUN_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// US-003: renderReport
// ---------------------------------------------------------------------------

describe("US-003 renderReport", () => {
  test("AC-19: renderReport importable as function", () => {
    expect(typeof renderReport).toBe("function");
  });

  test("AC-20: default report includes each story id once; failed story phase names on own lines", () => {
    const timeline = makeTimeline({
      stories: [
        makePassedStory("PASS-1", [{ name: "p1", status: "passed" }]),
        makeFailedStory("FAIL-1", [{ name: "phase1", status: "fail" }, { name: "phase2", status: "fail" }]),
      ],
    });
    const output = renderReport(timeline as any);
    expect(typeof output).toBe("string");
    expect((output.match(/PASS-1/g) ?? []).length).toBe(1);
    expect((output.match(/FAIL-1/g) ?? []).length).toBe(1);
    const lines = output.split("\n");
    expect(lines.some((l) => /phase1/.test(l))).toBe(true);
    expect(lines.some((l) => /phase2/.test(l))).toBe(true);
  });

  test("AC-21: default report collapses passed phases; expands failed phases", () => {
    const timeline = makeTimeline({
      stories: [
        makePassedStory("PASS-1", [{ name: "setup", status: "passed" }, { name: "execute", status: "passed" }]),
        makeFailedStory("FAIL-1", [{ name: "setup", status: "fail" }]),
      ],
    });
    const output = renderReport(timeline as any);
    const lines = output.split("\n");
    // PASS-1's "execute" phase must not appear on its own line
    const executeOnlyLines = lines.filter((l) => /execute/.test(l) && !/PASS-1|FAIL-1/.test(l));
    expect(executeOnlyLines.length).toBe(0);
    // FAIL-1's "setup" phase must appear
    const failSetupLines = lines.filter((l) => /setup/.test(l) && !/PASS-1/.test(l));
    expect(failSetupLines.length).toBeGreaterThan(0);
  });

  test("AC-22: --all flag expands passed story phases", () => {
    const timeline = makeTimeline({
      stories: [makePassedStory("PASS-1", [{ name: "phaseA", status: "passed" }, { name: "phaseB", status: "passed" }])],
    });
    const output = renderReport(timeline as any, { all: true });
    expect(output).toContain("phaseA");
    expect(output).toContain("phaseB");
  });

  test("AC-23: --story filter shows only the specified story", () => {
    const timeline = makeTimeline({
      stories: [makePassedStory("US-001"), makeFailedStory("US-002"), makePassedStory("US-003")],
    });
    const output = renderReport(timeline as any, { story: "US-002" });
    expect(/US-002/.test(output)).toBe(true);
    expect(/US-001/.test(output)).toBe(false);
    expect(/US-003/.test(output)).toBe(false);
  });

  test("AC-24: terminal failed phase line contains root cause marker", () => {
    const timeline = makeTimeline({
      stories: [makeFailedStory("FAIL-1", [{ name: "verify", status: "fail", isTerminal: true }])],
    });
    const output = renderReport(timeline as any);
    const lines = output.split("\n");
    const verifyLine = lines.find((l) => /verify/.test(l));
    expect(verifyLine).toBeDefined();
    expect(/root cause/i.test(verifyLine!)).toBe(true);
  });

  test("AC-25: report header contains runId, feature, status, story count, and cost", () => {
    const timeline = makeTimeline({
      runId: "run-abc",
      feature: "my-feature",
      status: "failed",
      stories: [makePassedStory("A"), makePassedStory("B"), makeFailedStory("C")],
      cost: 0.05,
    });
    const output = renderReport(timeline as any);
    expect(output).toContain("run-abc");
    expect(output).toContain("my-feature");
    expect(/failed/i.test(output)).toBe(true);
    expect(/3/.test(output)).toBe(true);
    expect(output).toContain("0.05");
  });

  test("AC-26: report includes best-effort/reconstructed notice", () => {
    const timeline = makeTimeline({
      stories: [makePassedStory("US-001", [{ name: "p", status: "passed", reconstructed: true }])],
    });
    const output = renderReport(timeline as any);
    expect(/best[- ]effort|reconstructed|from logs/i.test(output)).toBe(true);
  });

  test("AC-27: crashed timeline renders CRASHED header and placeholder for undefined cost", () => {
    const timeline = makeTimeline({
      status: "crashed",
      stories: [{ storyId: "US-001", status: "unknown", phases: [], cost: undefined }],
    });
    expect(() => renderReport(timeline as any)).not.toThrow();
    const output = renderReport(timeline as any);
    expect(output).toContain("CRASHED");
    expect(output).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// US-004: toReplayJson
// ---------------------------------------------------------------------------

describe("US-004 toReplayJson", () => {
  test("AC-28: toReplayJson importable as function", () => {
    expect(typeof toReplayJson).toBe("function");
  });

  test("AC-29: toReplayJson returns object matching timeline shape", () => {
    const timeline = {
      runId: "run-xyz",
      feature: "feat",
      status: "passed",
      inferred: true,
      naxVersion: "0.71.1",
      stories: [
        { storyId: "US-001", status: "passed", phases: [] },
        { storyId: "US-002", status: "passed", phases: [] },
      ],
    };
    const result = toReplayJson(timeline as any);
    expect(result.runId).toBe(timeline.runId);
    expect(result.feature).toBe(timeline.feature);
    expect(result.status).toBe(timeline.status);
    expect(result.stories.length).toBe(timeline.stories.length);
  });
});

// ---------------------------------------------------------------------------
// US-004: runReplay + registerReplayCommand seams
// ---------------------------------------------------------------------------

describe("US-004 runReplay seams", () => {
  const mockTimeline = {
    runId: "known-run-id",
    feature: "feat",
    status: "passed",
    inferred: true,
    naxVersion: "0.71.1",
    stories: [],
    cost: 0,
  };

  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = {
      discoverRun: _replayDeps.discoverRun,
      renderReport: _replayDeps.renderReport,
      toReplayJson: _replayDeps.toReplayJson,
      outputWrite: _replayDeps.outputWrite,
      errorWrite: _replayDeps.errorWrite,
    };
  });

  afterEach(() => {
    Object.assign(_replayDeps, saved);
  });

  test("AC-30: runReplay calls discoverRun exactly once with the query string", async () => {
    let callCount = 0;
    let callArg: unknown;
    _replayDeps.discoverRun = async (q: string) => { callCount++; callArg = q; return mockTimeline as any; };
    _replayDeps.renderReport = () => "ok";
    await runReplay("run-x", {});
    expect(callCount).toBe(1);
    expect(callArg).toBe("run-x");
  });

  test("AC-31: runReplay calls renderReport once with the reconstructed timeline", async () => {
    _replayDeps.discoverRun = async () => mockTimeline as any;
    let renderCount = 0;
    let renderArg: unknown;
    _replayDeps.renderReport = (tl: any) => { renderCount++; renderArg = tl; return "ok"; };
    await runReplay("query", {});
    expect(renderCount).toBe(1);
    expect((renderArg as any).runId).toBe("known-run-id");
  });

  test("AC-32: --json path calls toReplayJson, writes JSON output, skips renderReport", async () => {
    _replayDeps.discoverRun = async () => mockTimeline as any;
    let toJsonCount = 0;
    let renderCount = 0;
    const outputParts: string[] = [];
    _replayDeps.toReplayJson = (tl: any) => { toJsonCount++; return { runId: tl.runId }; };
    _replayDeps.renderReport = () => { renderCount++; return ""; };
    _replayDeps.outputWrite = (s: string) => outputParts.push(s);
    await runReplay("query", { json: true });
    expect(toJsonCount).toBe(1);
    expect(() => JSON.parse(outputParts.join(""))).not.toThrow();
    expect(renderCount).toBe(0);
  });

  test("AC-33: registerReplayCommand importable as function", () => {
    expect(typeof registerReplayCommand).toBe("function");
  });

  test("AC-34: registerReplayCommand adds replay subcommand with run-id arg and --json option", () => {
    const cmd = new Command();
    registerReplayCommand(cmd);
    const replayCmd = cmd.commands.find((c) => c.name() === "replay");
    expect(replayCmd).toBeDefined();
    expect(replayCmd!.options.some((o) => /--json/.test(o.flags))).toBe(true);
    // Override action to prevent side effects during parse
    replayCmd!.action(() => {});
    replayCmd!.exitOverride();
    replayCmd!.parse(["node", "replay", "run-id"]);
    const parsedRunId = replayCmd!.processedArgs[0] ?? replayCmd!.args[0];
    expect(parsedRunId).toBe("run-id");
  });

  test("AC-35: runReplay returns exit code 1 and writes message containing query for unknown run", async () => {
    _replayDeps.discoverRun = async () => {
      throw new NaxError("Run not found: missing", "RUN_NOT_FOUND", { stage: "discovery" });
    };
    const errParts: string[] = [];
    _replayDeps.errorWrite = (s: string) => errParts.push(s);
    const exitCode = await runReplay("missing", {});
    expect(exitCode).toBe(1);
    expect(errParts.join("")).toContain("missing");
  });

  test("AC-36: malformed JSONL lines skipped; renderReport called once with valid timeline", async () => {
    let tempDir: string | undefined;
    try {
      tempDir = await makeTempDir();
      const jsonlPath = join(tempDir, "run.jsonl");
      const l1 = JSON.stringify(makeLogEntry({ stage: "run.start", message: "started", data: { runId: "r" } }));
      const l2 = "{{INVALID JSON{{";
      const l3 = JSON.stringify(makeLogEntry({ message: "Phase passed: implementer", data: { storyId: STORY_ID } }));
      await Bun.write(jsonlPath, [l1, l2, l3].join("\n"));
      _replayDeps.discoverRun = async () => ({ jsonlPath, meta: { runId: "r", feature: "f" } } as any);
      let renderCount = 0;
      let capturedTimeline: unknown;
      _replayDeps.renderReport = (tl: any) => { renderCount++; capturedTimeline = tl; return "ok"; };
      const exitCode = await runReplay("query", {});
      expect(exitCode).toBe(0);
      expect(renderCount).toBe(1);
      expect(capturedTimeline).toBeDefined();
    } finally {
      if (tempDir) await cleanupTempDir(tempDir);
    }
  });

  test("AC-37: crashed run writes CRASHED report and returns exit code 0", async () => {
    const crashedTimeline = { ...mockTimeline, status: "crashed", stories: [] };
    _replayDeps.discoverRun = async () => crashedTimeline as any;
    const outputParts: string[] = [];
    _replayDeps.outputWrite = (s: string) => outputParts.push(s);
    _replayDeps.renderReport = (tl: any) => `CRASHED ${tl.runId}`;
    const exitCode = await runReplay("query", {});
    expect(exitCode).toBe(0);
    expect(outputParts.join("")).toContain("CRASHED");
  });
});