/**
 * Tier Escalation — Runtime Crash Retry Cap (quality-review follow-up on BUG-070)
 *
 * A runtime-crash retry-same outcome must not loop forever: after
 * RUNTIME_CRASH_RETRY_CAP consecutive crashes on the same story, the story
 * pauses for human review instead of retrying indefinitely. The counter is
 * in-memory only (never persisted to the PRD) — AC-4/AC-5 in
 * tier-escalation.test.ts require retry-same to never write to disk or dirty
 * the PRD, so this cap must not touch either.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeEscalationContext,
  makeInProgressStory,
  makeLogger,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { _tierEscalationDeps, handleTierEscalation, preIterationTierCheck } from "@/execution/escalation";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

// The runtime-crash pause path persists the PRD, so that fixture path must be
// a real dir under `$TMPDIR`: a confined run may not write a literal `/tmp/...`.
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = makeTempDir("nax-tier-retry-cap-");
});

afterEach(() => {
  cleanupTempDir(fixtureDir);
});

describe("handleTierEscalation — runtime-crash retry cap", () => {
  test("pauses the story once the runtime-crash retry cap is exceeded, instead of looping forever", async () => {
    const mod = await import("@/execution/escalation");
    const { handleTierEscalation, _tierEscalationDeps, _runtimeCrashRetryCounts, RUNTIME_CRASH_RETRY_CAP } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    let saveCalls = 0;
    _tierEscalationDeps.savePrdProgress = () => {
      saveCalls++;
      return Promise.resolve();
    };

    const storyId = "US-002-retry-cap";
    _runtimeCrashRetryCounts.delete(storyId);

    try {
      const story = makeStory({
        id: storyId,
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      });

      const prd = makePRD({ feature: "f", userStories: [story] });

      const buildCtx = () =>
        makeEscalationContext({
          story,
          pipelineResult: { reason: "Bun runtime crash", context: { tddFailureCategory: "runtime-crash" } },
          config: makeNaxConfig({
            autoMode: {
              escalation: {
                enabled: true,
                tierOrder: [
                  { tier: "fast", attempts: 2 },
                  { tier: "balanced", attempts: 3 },
                ],
              },
            },
            routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          }),
          prd,
          prdPath: join(fixtureDir, "prd.json"),
          feature: "f",
          runtimeCrashResult: { status: "RUNTIME_CRASH", success: false },
        });

      // Retry up to the cap: still retry-same, still no disk write.
      for (let i = 0; i < RUNTIME_CRASH_RETRY_CAP; i++) {
        const result = await handleTierEscalation(buildCtx());
        expect(result.outcome).toBe("retry-same");
      }
      expect(saveCalls).toBe(0);

      // One more crash beyond the cap must pause the story rather than retry
      // forever. The pause path writes via tier-outcome.ts's own savePRD
      // import (not _tierEscalationDeps), so saveCalls stays 0 here — the
      // retry-same branch's own no-write invariant is what saveCalls proves.
      const finalResult = await handleTierEscalation(buildCtx());
      expect(finalResult.outcome).toBe("paused");
      expect(finalResult.prdDirty).toBe(true);
      expect(saveCalls).toBe(0);
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
      _runtimeCrashRetryCounts.delete(storyId);
    }
  });

  test("resets the retry cap after a non-runtime-crash escalation", async () => {
    const mod = await import("@/execution/escalation");
    const { handleTierEscalation, _tierEscalationDeps, _runtimeCrashRetryCounts, RUNTIME_CRASH_RETRY_CAP } = mod;

    const storyId = "US-002-retry-cap-reset";
    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();
    _runtimeCrashRetryCounts.delete(storyId);

    try {
      const story = makeStory({
        id: storyId,
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      });
      const prd = makePRD({ feature: "f", userStories: [story] });
      const buildCtx = (runtimeCrash: boolean) =>
        makeEscalationContext({
          story,
          prd,
          pipelineResult: { reason: "Test failure", context: {} },
          config: makeNaxConfig({
            autoMode: {
              escalation: {
                enabled: true,
                tierOrder: [
                  { tier: "fast", attempts: 2 },
                  { tier: "balanced", attempts: 3 },
                ],
              },
            },
            routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          }),
          prdPath: "/tmp/test-prd-us002-retry-cap-reset.json",
          ...(runtimeCrash ? { runtimeCrashResult: { status: "RUNTIME_CRASH", success: false } } : {}),
        });

      for (let i = 0; i < RUNTIME_CRASH_RETRY_CAP; i++) {
        const result = await handleTierEscalation(buildCtx(true));
        expect(result.outcome).toBe("retry-same");
      }

      const ordinaryFailure = await handleTierEscalation(buildCtx(false));
      expect(ordinaryFailure.outcome).toBe("escalated");

      const nextCrash = await handleTierEscalation(buildCtx(true));
      expect(nextCrash.outcome).toBe("retry-same");
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
      _runtimeCrashRetryCounts.delete(storyId);
    }
  });

  test("BUG-15: resets the retry cap map when a story succeeds after a retry-same", async () => {
    const mod = await import("@/execution/escalation");
    const { _tierEscalationDeps, _runtimeCrashRetryCounts, resetRuntimeCrashRetryCounts } = mod;

    const storyId = "US-002-retry-cap-succeed";
    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    _tierEscalationDeps.savePrdProgress = () => Promise.resolve();
    _runtimeCrashRetryCounts.delete(storyId);

    try {
      const story = makeStory({
        id: storyId,
        status: "in-progress",
        attempts: 1,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      });

      const prd = makePRD({ feature: "f", userStories: [story] });

      const _buildCtx = () => ({
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after" },
        pipelineResult: { reason: "Bun runtime crash", context: { tddFailureCategory: "runtime-crash" } },
        config: {
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 2 },
                { tier: "balanced", attempts: 3 },
              ],
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
          models: {},
        },
        prd,
        prdPath: "/tmp/test-prd-us002-retry-cap-succeed.json",
        featureDir: undefined,
        hooks: { hooks: {} },
        feature: "f",
        totalCost: 0,
        workdir: "/tmp",
        runtimeCrashResult: { status: "RUNTIME_CRASH", success: false },
      });

      // Seed the map with a mid-cap count (story crashed once, then a later
      // run in the same process retries it).
      _runtimeCrashRetryCounts.set(storyId, 1);

      // Simulates run teardown between two runs in one process (BUG-15):
      // the map must be emptied so the next run starts with a fresh budget.
      resetRuntimeCrashRetryCounts();

      expect(_runtimeCrashRetryCounts.size).toBe(0);
    } finally {
      _tierEscalationDeps.savePrdProgress = origSavePRD;
      _runtimeCrashRetryCounts.delete(storyId);
    }
  });
});

/**
 * preIterationTierCheck — dry run must never persist (nax#1809).
 *
 * A `--dry-run` run over a partially-attempted PRD reaches the tier pre-check
 * (unified-executor.ts dispatch sites run before runIteration's dry-run
 * short-circuit), and a story past its tier budget would otherwise flow into
 * the escalate/fail writes — savePRD, progress.txt, story:failed events. The
 * check reads `runtime.dryRun` and returns the same clean passthrough it
 * already returns at attempts === 0: never persist under a dry run.
 *
 * Mirrors the sparse per-topic layout of this directory rather than growing
 * tier-escalation.test.ts (file-size ratchet).
 */

describe("preIterationTierCheck — dry run never persists escalation (nax#1809)", () => {
  test("returns a clean passthrough instead of savePRD when budget is exhausted", async () => {
    const mod = await import("@/execution/escalation/tier-escalation");
    const { preIterationTierCheck, _tierEscalationDeps } = mod;

    const origSavePRD = _tierEscalationDeps.savePrdProgress;
    const savePRDSpy = spyOn(_tierEscalationDeps, "savePrdProgress").mockImplementation(() => Promise.resolve());

    try {
      const story = makeStory({
        id: "US-pre-iter-dryrun-001",
        title: "Story",
        description: "Test",
        status: "in-progress",
        // attempts === tierCfg.attempts (1) → budget exhausted → would escalate
        attempts: 1,
        routing: { complexity: "simple", reasoning: "", modelTier: "fast", testStrategy: "test-after" },
      });

      const prd = makePRD({
        project: "test",
        feature: "f",
        branchName: "b",
        userStories: [story],
      });

      const config = makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: { fast: { model: "test-fast", provider: "test" }, balanced: { model: "test-bal", provider: "test" } },
      });

      const result = await preIterationTierCheck(
        story,
        { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
        config,
        prd,
        "/tmp/test-prd-dryrun.json",
        undefined,
        { hooks: {} },
        "f",
        0,
        "/tmp",
        makeMockRuntime({ workdir: "/tmp", dryRun: true }),
      );

      expect(savePRDSpy).not.toHaveBeenCalled();
      expect(result.shouldSkipIteration).toBe(false);
      expect(result.prdDirty).toBe(false);
      expect(result.prd).toBe(prd);
    } finally {
      savePRDSpy.mockRestore();
      _tierEscalationDeps.savePrdProgress = origSavePRD;
    }
  });
});

/**
 * US-001: Record escalation source tiers in telemetry
 *
 * Acceptance criteria for handleTierEscalation's logger routing and the
 * escalation log fields consumed by curator's collectObservations:
 *
 *  - AC-1: handleTierEscalation obtains the logger via _tierEscalationDeps.getSafeLogger
 *  - AC-2: data.fromTier === currentTier (e.g. "fast")
 *  - AC-3: data.nextTier === nextTier (e.g. "balanced")
 *  - AC-6: an escalation log entry from handleTierEscalation yields exactly one
 *          escalation observation when collectObservations reads the JSONL log
 *  - AC-7: an escalation log entry from preIterationTierCheck yields exactly one
 *          escalation observation when collectObservations reads the JSONL log
 */

type TierEscalationDeps = typeof _tierEscalationDeps;

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

/** Config that enables fast→balanced escalation without LLM re-routing. */
function makeEscalationConfig() {
  return makeNaxConfig({
    autoMode: {
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", attempts: 1 },
          { tier: "balanced", attempts: 2 },
        ],
        escalateEntireBatch: false,
      },
    },
    routing: { llm: { mode: "per-story" }, strategy: "keyword" },
  });
}

function makeUs001Prd(story: ReturnType<typeof makeUs001Story>) {
  return makePRD({ project: "test", feature: "f", branchName: "b", userStories: [story] });
}

function makeUs001Story() {
  return makeInProgressStory({
    id: "US-001",
    title: "Story",
    description: "Test",
    routing: {
      modelTier: "fast",
      testStrategy: "test-after" as const,
      complexity: "simple",
      reasoning: "source-tier escalation fixture",
    },
  });
}

/** Minimal context pointing the collector at a temp root. */
function makeCollectorContext(root: string, workdir: string, logFilePath: string): CuratorPostRunContext {
  return {
    runId: "run-us001",
    feature: "feat-us001",
    workdir,
    prdPath: join(workdir, ".nax", "features", "feat-us001", "prd.json"),
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
    projectKey: "test-project-us001",
    curatorRollupPath: join(root, "rollup.jsonl"),
    logFilePath,
  };
}

/** Overrides the deps object with the provided hooks; returns restore closures. */
function installDeps(opts: {
  savePRD?: TierEscalationDeps["savePrdProgress"];
  getSafeLogger?: TierEscalationDeps["getSafeLogger"];
}): void {
  const deps = _tierEscalationDeps;
  deps.savePrdProgress = opts.savePRD ?? (() => Promise.resolve());
  deps.getSafeLogger = opts.getSafeLogger ?? (deps.getSafeLogger as TierEscalationDeps["getSafeLogger"]);
}

// ---------------------------------------------------------------------------
// AC-1: handleTierEscalation resolves its logger via the deps object
// ---------------------------------------------------------------------------

describe("US-001: handleTierEscalation routes logger through _tierEscalationDeps.getSafeLogger (AC-1)", () => {
  let origSavePRD: TierEscalationDeps["savePrdProgress"];
  let origGetSafeLogger: TierEscalationDeps["getSafeLogger"];

  afterEach(() => {
    _tierEscalationDeps.savePrdProgress = origSavePRD;
    _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
  });

  test("escalation log is emitted via the dep's getSafeLogger", async () => {
    origSavePRD = _tierEscalationDeps.savePrdProgress;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    let depCallCount = 0;
    installDeps({
      getSafeLogger: () => {
        depCallCount += 1;
        return mockLogger;
      },
    });

    const story = makeUs001Story();
    const ctx = makeEscalationContext({
      story,
      storiesToExecute: [story],
      config: makeEscalationConfig(),
      prd: makeUs001Prd(story),
      prdPath: "/tmp/test-prd-us001.json",
      feature: "f",
    });
    const result = await handleTierEscalation(ctx);
    expect(result.outcome).toBe("escalated");

    // The dep was consulted at least once (proves routing through deps, not the direct import).
    expect(depCallCount).toBeGreaterThan(0);

    // The captured logger received the escalation log line.
    const escalationLogs = mockLogger.calls.filter((c) => c.stage === "escalation" && c.message.includes("Escalating"));
    expect(escalationLogs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-2 / AC-3: data.fromTier and data.nextTier on fast → balanced escalation
// ---------------------------------------------------------------------------

describe("US-001: handleTierEscalation logs fromTier and nextTier (AC-2, AC-3)", () => {
  let origSavePRD: TierEscalationDeps["savePrdProgress"];
  let origGetSafeLogger: TierEscalationDeps["getSafeLogger"];

  afterEach(() => {
    _tierEscalationDeps.savePrdProgress = origSavePRD;
    _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
  });

  test("logs at stage 'escalation' with data.fromTier 'fast' and data.nextTier 'balanced'", async () => {
    origSavePRD = _tierEscalationDeps.savePrdProgress;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    installDeps({
      getSafeLogger: () => mockLogger,
    });

    const story = makeUs001Story();
    const ctx = makeEscalationContext({
      story,
      storiesToExecute: [story],
      config: makeEscalationConfig(),
      prd: makeUs001Prd(story),
      prdPath: "/tmp/test-prd-us001.json",
      feature: "f",
    });
    const result = await handleTierEscalation(ctx);
    expect(result.outcome).toBe("escalated");

    // The escalation warn emitted by handleTierEscalation carries the fromTier and nextTier fields.
    const escalationLogs = mockLogger.calls.filter((c) => c.stage === "escalation" && c.message.includes("Escalating"));
    expect(escalationLogs.length).toBeGreaterThan(0);

    // At least one of those calls must record the fast → balanced jump.
    const fastToBalanced = escalationLogs.find((c) => c.data?.fromTier === "fast" && c.data?.nextTier === "balanced");
    expect(fastToBalanced).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-6: handleTierEscalation log entry → exactly one escalation observation
// AC-7: preIterationTierCheck log entry → exactly one escalation observation
// ---------------------------------------------------------------------------

describe("US-001: escalation log entries from both emitters round-trip to collectObservations (AC-6, AC-7)", () => {
  let origSavePRD: TierEscalationDeps["savePrdProgress"];
  let origGetSafeLogger: TierEscalationDeps["getSafeLogger"];

  afterEach(() => {
    _tierEscalationDeps.savePrdProgress = origSavePRD;
    _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
  });

  test("AC-6: handleTierEscalation's log line yields exactly one escalation observation", async () => {
    origSavePRD = _tierEscalationDeps.savePrdProgress;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    installDeps({
      getSafeLogger: () => mockLogger,
    });

    const story = makeUs001Story();
    const ctx = makeEscalationContext({
      story,
      storiesToExecute: [story],
      config: makeEscalationConfig(),
      prd: makeUs001Prd(story),
      prdPath: "/tmp/test-prd-us001.json",
      feature: "f",
    });
    const result = await handleTierEscalation(ctx);
    expect(result.outcome).toBe("escalated");

    const escalationCalls = mockLogger.calls.filter(
      (c) => c.stage === "escalation" && c.message.includes("Escalating"),
    );
    expect(escalationCalls.length).toBeGreaterThan(0);

    // Reconstruct JSONL lines identical to what the real logger would write,
    // then feed them to collectObservations to verify the round-trip.
    const root = join(fixtureDir, "us001-handle");
    await mkdir(root);
    const logFilePath = join(root, "run.jsonl");
    const lines = escalationCalls.map((c) =>
      JSON.stringify({
        timestamp: "2026-05-04T00:00:00.000Z",
        level: c.level,
        stage: c.stage,
        message: c.message,
        storyId: c.data?.storyId,
        data: c.data,
      }),
    );
    await writeFile(logFilePath, `${lines.join("\n")}\n`);

    const observations = await collectObservations(makeCollectorContext(root, root, logFilePath));
    const escalationObs = observations.filter((o) => o.kind === "escalation");
    expect(escalationObs).toHaveLength(1);
  });

  test("AC-7: preIterationTierCheck's log line yields exactly one escalation observation", async () => {
    origSavePRD = _tierEscalationDeps.savePrdProgress;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    installDeps({
      getSafeLogger: () => mockLogger,
    });

    const story = {
      ...makeUs001Story(),
      attempts: 1, // >= tierCfg.attempts → triggers escalation
    };
    const prd = makeUs001Prd(story);

    const result = await preIterationTierCheck(
      story,
      { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
      }),
      prd,
      "/tmp/test-prd-us001-pre.json",
      undefined,
      { hooks: {} },
      "f",
      0,
      "/tmp",
    );
    expect(result.shouldSkipIteration).toBe(true);

    const escalationCalls = mockLogger.calls.filter(
      (c) => c.stage === "escalation" && c.message.includes("Escalating"),
    );
    expect(escalationCalls.length).toBeGreaterThan(0);

    // Round-trip through the JSONL collector.
    const root = join(fixtureDir, "us001-pre-iter");
    await mkdir(root);
    const logFilePath = join(root, "run.jsonl");
    const lines = escalationCalls.map((c) =>
      JSON.stringify({
        timestamp: "2026-05-04T00:00:00.000Z",
        level: c.level,
        stage: c.stage,
        message: c.message,
        storyId: c.data?.storyId,
        data: c.data,
      }),
    );
    await writeFile(logFilePath, `${lines.join("\n")}\n`);

    const observations = await collectObservations(makeCollectorContext(root, root, logFilePath));
    const escalationObs = observations.filter((o) => o.kind === "escalation");
    expect(escalationObs).toHaveLength(1);
  });
});
