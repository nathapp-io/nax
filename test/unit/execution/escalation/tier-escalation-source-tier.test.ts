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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInProgressStory, makeLogger } from "@test/helpers";
import { _tierEscalationDeps, handleTierEscalation, preIterationTierCheck } from "@/execution/escalation";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

type TierEscalationDeps = typeof _tierEscalationDeps;

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

function makeBaseContext() {
  return {
    isBatchExecution: false,
    pipelineResult: { reason: "Tests failed", context: {} },
    config: {
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
      models: {},
    },
    prd: {
      project: "test",
      feature: "f",
      branchName: "b",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Story",
          description: "Test",
          acceptanceCriteria: [],
          tags: [],
          dependencies: [],
          status: "in-progress" as const,
          passes: false,
          escalations: [],
          attempts: 0,
          routing: { modelTier: "fast", testStrategy: "test-after" as const },
        },
      ],
    },
    prdPath: "/tmp/test-prd-us001.json",
    featureDir: undefined,
    hooks: { hooks: {} },
    feature: "f",
    totalCost: 0,
    workdir: "/tmp",
  };
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
    config: {} as any,
    outputDir: join(root, "out"),
    globalDir: join(root, "global"),
    projectKey: "test-project-us001",
    curatorRollupPath: join(root, "rollup.jsonl"),
    logFilePath,
  };
}

/** Overrides the deps object with the provided hooks; returns restore closures. */
function installDeps(opts: {
  savePRD?: TierEscalationDeps["savePRD"];
  getSafeLogger?: TierEscalationDeps["getSafeLogger"];
}): void {
  const deps = _tierEscalationDeps;
  deps.savePRD = opts.savePRD ?? (() => Promise.resolve());
  deps.getSafeLogger = opts.getSafeLogger ?? (deps.getSafeLogger as TierEscalationDeps["getSafeLogger"]);
}

// ---------------------------------------------------------------------------
// AC-1: handleTierEscalation resolves its logger via the deps object
// ---------------------------------------------------------------------------

describe("US-001: handleTierEscalation routes logger through _tierEscalationDeps.getSafeLogger (AC-1)", () => {
  let origSavePRD: TierEscalationDeps["savePRD"];
  let origGetSafeLogger: TierEscalationDeps["getSafeLogger"];

  afterEach(() => {
    _tierEscalationDeps.savePRD = origSavePRD;
    _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
  });

  test("escalation log is emitted via the dep's getSafeLogger", async () => {
    origSavePRD = _tierEscalationDeps.savePRD;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    let depCallCount = 0;
    installDeps({
      getSafeLogger: () => {
        depCallCount += 1;
        // test-ratchet-allow: as-unknown-as
        return mockLogger as unknown as ReturnType<typeof origGetSafeLogger>; // test-ratchet-allow: as-unknown-as
      },
    });

    const base = makeBaseContext();
    const ctx = {
      ...base,
      story: base.prd.userStories[0],
      storiesToExecute: [base.prd.userStories[0]],
      routing: { modelTier: "fast", testStrategy: "test-after" },
    };
    // test-ratchet-allow: as-unknown-as
    const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]); // test-ratchet-allow: as-unknown-as
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
  let origSavePRD: TierEscalationDeps["savePRD"];
  let origGetSafeLogger: TierEscalationDeps["getSafeLogger"];

  afterEach(() => {
    _tierEscalationDeps.savePRD = origSavePRD;
    _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
  });

  test("logs at stage 'escalation' with data.fromTier 'fast' and data.nextTier 'balanced'", async () => {
    origSavePRD = _tierEscalationDeps.savePRD;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    installDeps({
      // test-ratchet-allow: as-unknown-as
      getSafeLogger: () => mockLogger as unknown as ReturnType<typeof origGetSafeLogger>, // test-ratchet-allow: as-unknown-as
    });

    const base = makeBaseContext();
    const ctx = {
      ...base,
      story: base.prd.userStories[0],
      storiesToExecute: [base.prd.userStories[0]],
      routing: { modelTier: "fast", testStrategy: "test-after" },
    };
    // test-ratchet-allow: as-unknown-as
    const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]); // test-ratchet-allow: as-unknown-as
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
  let origSavePRD: TierEscalationDeps["savePRD"];
  let origGetSafeLogger: TierEscalationDeps["getSafeLogger"];

  afterEach(() => {
    _tierEscalationDeps.savePRD = origSavePRD;
    _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
  });

  test("AC-6: handleTierEscalation's log line yields exactly one escalation observation", async () => {
    origSavePRD = _tierEscalationDeps.savePRD;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    installDeps({
      // test-ratchet-allow: as-unknown-as
      getSafeLogger: () => mockLogger as unknown as ReturnType<typeof origGetSafeLogger>, // test-ratchet-allow: as-unknown-as
    });

    const base = makeBaseContext();
    const ctx = {
      ...base,
      story: base.prd.userStories[0],
      storiesToExecute: [base.prd.userStories[0]],
      routing: { modelTier: "fast", testStrategy: "test-after" },
    };
    // test-ratchet-allow: as-unknown-as
    const result = await handleTierEscalation(ctx as unknown as Parameters<typeof handleTierEscalation>[0]); // test-ratchet-allow: as-unknown-as
    expect(result.outcome).toBe("escalated");

    const escalationCalls = mockLogger.calls.filter(
      (c) => c.stage === "escalation" && c.message.includes("Escalating"),
    );
    expect(escalationCalls.length).toBeGreaterThan(0);

    // Reconstruct JSONL lines identical to what the real logger would write,
    // then feed them to collectObservations to verify the round-trip.
    const root = await mkdtemp(join(tmpdir(), "us001-handle-"));
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
    origSavePRD = _tierEscalationDeps.savePRD;
    origGetSafeLogger = _tierEscalationDeps.getSafeLogger;

    const mockLogger = makeLogger();
    installDeps({
      // test-ratchet-allow: as-unknown-as
      getSafeLogger: () => mockLogger as unknown as ReturnType<typeof origGetSafeLogger>, // test-ratchet-allow: as-unknown-as
    });

    const story = {
      ...makeUs001Story(),
      attempts: 1, // >= tierCfg.attempts → triggers escalation
    };

    const prd = {
      project: "test",
      feature: "f",
      branchName: "b",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    };

    const result = await preIterationTierCheck(
      // test-ratchet-allow: as-unknown-as
      story as unknown as Parameters<typeof preIterationTierCheck>[0], // test-ratchet-allow: as-unknown-as
      { modelTier: "fast" },
      {
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
        models: {},
        // test-ratchet-allow: as-unknown-as
      } as unknown as Parameters<typeof preIterationTierCheck>[2], // test-ratchet-allow: as-unknown-as
      // test-ratchet-allow: as-unknown-as
      prd as unknown as Parameters<typeof preIterationTierCheck>[3], // test-ratchet-allow: as-unknown-as
      "/tmp/test-prd-us001-pre.json",
      undefined,
      // test-ratchet-allow: as-unknown-as
      { hooks: {} } as unknown as Parameters<typeof preIterationTierCheck>[6], // test-ratchet-allow: as-unknown-as
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
    const root = await mkdtemp(join(tmpdir(), "us001-pre-iter-"));
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
