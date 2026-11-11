/**
 * Tier Escalation — dry-run persistence and escalation telemetry
 *
 * The escalation layer's side effects and its log shape: a dry run never
 * persists an escalation, and the escalation log line carries the source tier
 * and the next tier.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { _tierEscalationDeps, handleTierEscalation } from "@/execution/escalation";

// The runtime-crash pause path persists the PRD, so that fixture path must be
// a real dir under `$TMPDIR`: a confined run may not write a literal `/tmp/...`.
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = makeTempDir("nax-tier-retry-cap-");
});

afterEach(() => {
  cleanupTempDir(fixtureDir);
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
 * escalation log fields:
 *
 *  - AC-1: handleTierEscalation obtains the logger via _tierEscalationDeps.getSafeLogger
 *  - AC-2: data.fromTier === currentTier (e.g. "fast")
 *  - AC-3: data.nextTier === nextTier (e.g. "balanced")
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
