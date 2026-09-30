import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeFixCycleResult,
  makeMockCallContext,
  makeNaxConfig,
  makeTestRuntime,
  withInfoSpy,
  withWarnSpy,
} from "@test/helpers";
import { pickSelector, type PipelineStage, type NaxConfig } from "@/config";
import type { Finding } from "@/findings";
import type { FixCycle, FixCycleContext } from "@/findings/cycle-types";
import { ExecutionPlan, _storyOrchestratorDeps, runRectification, StoryOrchestratorBuilder } from "@/execution";
import {
  type PhaseTracking,
  type PlanParams,
  runCanonicalLoop,
} from "@/execution/story-orchestrator/execution-plan-phases";
import type { InternalBuildState, InternalPhase } from "@/execution/story-orchestrator/types";
import type { RunOperation } from "@/operations";
import type { CallContext } from "@/operations/types";
import type { NaxRuntime } from "@/runtime";
import type { SessionRole } from "@/session";

// ─────────────────────────────────────────────────────────────────────────────
// Loose-typed dynamic loaders for the modules this feature introduces.
// A missing module throws inside the tests that need it — the rest still run.
// ─────────────────────────────────────────────────────────────────────────────

interface ReviewPairModule {
  shouldRunReviewsConcurrently: (reviewConfig: unknown, phases: readonly string[]) => boolean;
  runReviewPair: (
    ctx: unknown,
    pair: readonly string[],
    tracking: PhaseTracking,
    isThreeSession?: boolean,
    progress?: unknown,
  ) => Promise<void>;
  _reviewPairDeps: { runPhase: (...args: unknown[]) => Promise<unknown> };
}

async function loadReviewPair(): Promise<ReviewPairModule> {
  const mod = (await import("@/execution/story-orchestrator/review-pair")) as unknown as Partial<ReviewPairModule>;
  if (typeof mod.shouldRunReviewsConcurrently !== "function") {
    throw new Error("shouldRunReviewsConcurrently is not exported from @/execution/story-orchestrator/review-pair");
  }
  if (typeof mod.runReviewPair !== "function") {
    throw new Error("runReviewPair is not exported from @/execution/story-orchestrator/review-pair");
  }
  if (!mod._reviewPairDeps || typeof mod._reviewPairDeps.runPhase !== "function") {
    throw new Error("_reviewPairDeps.runPhase is missing from @/execution/story-orchestrator/review-pair");
  }
  return mod as ReviewPairModule;
}

interface RevalidationReviewsModule {
  dispatchRevalidationPhase: (
    ctx: unknown,
    phase: string,
    phases: readonly string[],
    tracking: PhaseTracking,
    isThreeSession?: boolean,
  ) => Promise<readonly string[]>;
}

async function loadRevalidationReviews(): Promise<RevalidationReviewsModule> {
  const mod = (await import(
    "@/execution/story-orchestrator/revalidation-reviews"
  )) as unknown as Partial<RevalidationReviewsModule>;
  if (typeof mod.dispatchRevalidationPhase !== "function") {
    throw new Error(
      "dispatchRevalidationPhase is not exported from @/execution/story-orchestrator/revalidation-reviews",
    );
  }
  return mod as RevalidationReviewsModule;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small async helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function flushTurns(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await tick();
}

/** Poll until `pred` holds or the timeout elapses; returns whether it held. */
async function untilTrue(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) return false;
    await tick(5);
  }
  return true;
}

/**
 * Extract the phase identity from whatever shape `runPhase`-style seams receive:
 * a plain phase-name string, an InternalPhase ({ kind }), an op ({ name }), or a
 * slot ({ op: { name } }). Keeps the stubs honest about WHICH phase they saw
 * regardless of the caller's parameter representation.
 */
function phaseNameOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const v = value as { kind?: unknown; name?: unknown; op?: unknown };
    if (typeof v.kind === "string") return v.kind;
    if (typeof v.name === "string") return v.name;
    if (v.op !== null && typeof v.op === "object") {
      const opName = (v.op as { name?: unknown }).name;
      if (typeof opName === "string") return opName;
    }
  }
  return String(value);
}

/** Install a stub on the `_reviewPairDeps.runPhase` seam for the duration of `fn`. */
async function withPairRunPhaseStub<T>(
  stub: (...args: unknown[]) => Promise<unknown>,
  fn: (runReviewPair: ReviewPairModule["runReviewPair"]) => Promise<T>,
): Promise<T> {
  const pair = await loadReviewPair();
  const original = pair._reviewPairDeps.runPhase;
  pair._reviewPairDeps.runPhase = stub;
  try {
    return await fn(pair.runReviewPair);
  } finally {
    pair._reviewPairDeps.runPhase = original;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger spies (the helpers ship warn/info/debug; error and all-levels live here)
// ─────────────────────────────────────────────────────────────────────────────

type LogArgs = [stage: string, message: string, data: Record<string, unknown> | undefined];

async function withErrorSpy(fn: (calls: LogArgs[]) => Promise<void>): Promise<void> {
  const { resetLogger, initLogger } = await import("@/logger");
  resetLogger();
  const logger = initLogger({ level: "silent" });
  const calls: LogArgs[] = [];
  const original = logger.error;
  logger.error = (stage: string, message: string, data?: Record<string, unknown>) => {
    calls.push([stage, message, data]);
  };
  try {
    await fn(calls);
  } finally {
    logger.error = original;
    resetLogger();
  }
}

interface CapturedLog {
  level: "error" | "warn" | "info" | "debug";
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

async function withAllLevelsCapture(fn: (logs: CapturedLog[]) => Promise<void>): Promise<void> {
  const { resetLogger, initLogger } = await import("@/logger");
  resetLogger();
  const logger = initLogger({ level: "silent" });
  const logs: CapturedLog[] = [];
  const levels = ["error", "warn", "info", "debug"] as const;
  const originals = new Map<string, unknown>();
  for (const level of levels) {
    originals.set(level, logger[level]);
    logger[level] = (stage: string, message: string, data?: Record<string, unknown>) => {
      logs.push({ level, stage, message, data });
    };
  }
  try {
    await fn(logs);
  } finally {
    for (const [level, original] of originals) {
      (logger as unknown as Record<string, unknown>)[level] = original;
    }
    resetLogger();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Op fixtures, review envelopes, findings
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-parallel-review-pair-sel", "execution");
type TestOpConfig = ReturnType<typeof testSel.select>;

function makeOrchestratorOp(
  name: string,
  stage: PipelineStage,
  role: SessionRole,
): RunOperation<{ story: string }, Record<string, unknown>, TestOpConfig> {
  return {
    kind: "run",
    name,
    stage,
    config: testSel,
    session: { role, lifetime: "fresh" },
    build: () => ({
      role: { id: "r", content: name, overridable: false },
      task: { id: "t", content: "", overridable: false },
    }),
    parse: () => ({ success: true }),
  };
}

const PASS_REVIEW: Record<string, unknown> = { success: true, passed: true, findings: [], normalizedFindings: [] };

function failReviewEnvelope(findings: readonly Finding[]): Record<string, unknown> {
  return { success: false, passed: false, findings: [...findings], normalizedFindings: [...findings] };
}

const SEMANTIC_FIXTURE_FINDINGS: Finding[] = [
  { source: "semantic-review", severity: "error", category: "", message: "SEM-FIXTURE-1 unhandled null path", file: "src/a.ts" },
  { source: "semantic-review", severity: "error", category: "", message: "SEM-FIXTURE-2 off-by-one in loop", file: "src/b.ts" },
];

const ADVERSARIAL_FIXTURE_FINDING: Finding = {
  source: "adversarial-review",
  severity: "error",
  category: "test-gap",
  message: "ADV-FIXTURE-1 missing error-path coverage",
  file: "test/a.test.ts",
  fixTarget: "test",
};

const LINT_FAILING_OUTPUT: Record<string, unknown> = {
  success: false,
  findings: [{ source: "lint", tool: "biome", severity: "error", category: "", message: "lint failed", file: "src/c.ts" }],
};

// ─────────────────────────────────────────────────────────────────────────────
// Tracked callOp factory — records every dispatched op name in call order,
// answers held phases with manually-controlled deferreds.
// ─────────────────────────────────────────────────────────────────────────────

interface TrackedCallOp {
  calls: string[];
  deferreds: Map<string, Deferred<Record<string, unknown>>>;
  callOp: typeof _storyOrchestratorDeps.callOp;
}

function makeTrackedCallOp(opts: {
  /** Resolved output per phase name; unlisted phases get a passing envelope. */
  outputs?: Record<string, Record<string, unknown>>;
  /** Phases answered with a manually-controlled deferred instead of a value. */
  hold?: readonly string[];
  /** Invoked with the phase name on every dispatch (for in-flight ordering). */
  onDispatch?: (phase: string) => void;
} = {}): TrackedCallOp {
  const calls: string[] = [];
  const deferreds = new Map<string, Deferred<Record<string, unknown>>>();
  const impl = async (_ctx: unknown, op: { name: string }, _input: unknown): Promise<unknown> => {
    const name = op.name;
    calls.push(name);
    opts.onDispatch?.(name);
    if (opts.hold?.includes(name)) {
      const deferred = makeDeferred<Record<string, unknown>>();
      deferreds.set(name, deferred);
      return deferred.promise;
    }
    if (opts.outputs && name in opts.outputs) return opts.outputs[name];
    return { ...PASS_REVIEW };
  };
  return { calls, deferreds, callOp: impl as unknown as typeof _storyOrchestratorDeps.callOp };
}

function countCalls(calls: readonly string[], phase: string): number {
  return calls.filter((name) => name === phase).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config + ctx builders
// ─────────────────────────────────────────────────────────────────────────────

function parallelOnConfig(overrides: { maxConcurrentSessions?: number } = {}): NaxConfig {
  return makeNaxConfig({
    review: {
      enabled: true,
      checks: ["semantic", "adversarial"],
      adversarial: { parallel: true, ...overrides },
    },
  });
}

function parallelOffConfig(): NaxConfig {
  return makeNaxConfig({
    review: {
      enabled: true,
      checks: ["semantic", "adversarial"],
      adversarial: { parallel: false },
    },
  });
}

function makeCtxWithConfig(config: NaxConfig, storyId: string): CallContext {
  const runtime = makeTestRuntime({ config });
  return makeMockCallContext({ runtime, config, storyId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan builders
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal plan: implementer → semantic-review → adversarial-review (no rectification). */
function makeReviewPairPlan(ctx: CallContext): ExecutionPlan {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: makeOrchestratorOp("implementer", "run", "implementer"), input: { story: "s" } })
    .addSemanticReview({ op: makeOrchestratorOp("semantic-review", "review", "reviewer-semantic"), input: { story: "s" } })
    .addAdversarialReview({
      op: makeOrchestratorOp("adversarial-review", "review", "reviewer-adversarial"),
      input: { story: "s" },
    })
    .build(ctx);
}

/** Full sweep plan: every rectification-relevant phase + rectification configured. */
function makeSweepPlan(ctx: CallContext, opts: { isThreeSession?: boolean } = {}): ExecutionPlan {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: makeOrchestratorOp("implementer", "run", "implementer"), input: { story: "s" } })
    .addFullSuiteGate({ op: makeOrchestratorOp("full-suite-gate", "verify", "verifier"), input: { story: "s" } })
    .addVerifier({ op: makeOrchestratorOp("verifier", "verify", "verifier"), input: { story: "s" } })
    .addVerifyScoped({ op: makeOrchestratorOp("verify-scoped", "verify", "verifier"), input: { story: "s" } })
    .addLintCheck({ op: makeOrchestratorOp("lint-check", "verify", "verifier"), input: { story: "s" } })
    .addTypecheckCheck({ op: makeOrchestratorOp("typecheck-check", "verify", "verifier"), input: { story: "s" } })
    .addSemanticReview({ op: makeOrchestratorOp("semantic-review", "review", "reviewer-semantic"), input: { story: "s" } })
    .addAdversarialReview({
      op: makeOrchestratorOp("adversarial-review", "review", "reviewer-adversarial"),
      input: { story: "s" },
    })
    .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
    .build(ctx, { isThreeSession: opts.isThreeSession ?? false });
}

/** The two review phases as a standalone orderedPhases list for runCanonicalLoop. */
function reviewPairPhases(): InternalPhase[] {
  return [
    { kind: "semantic-review", slot: { op: makeOrchestratorOp("semantic-review", "review", "reviewer-semantic"), input: { story: "loop" } } },
    {
      kind: "adversarial-review",
      slot: { op: makeOrchestratorOp("adversarial-review", "review", "reviewer-adversarial"), input: { story: "loop" } },
    },
  ];
}

interface LoopRunResult {
  shortCircuitPhase?: string;
}

async function runLoopWith(ctx: CallContext, phases: readonly InternalPhase[]): Promise<LoopRunResult> {
  const plan: PlanParams = { ctx, state: {}, isThreeSession: false };
  const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
  return runCanonicalLoop(plan, tracking, phases);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps save/restore — every integration test mutates _storyOrchestratorDeps
// ─────────────────────────────────────────────────────────────────────────────

type StoryDepsKey = "callOp" | "runFixCycle" | "recordGreen" | "captureGitRef" | "buildResumePlan" | "captureTreeState";
const STORY_DEPS_KEYS: readonly StoryDepsKey[] = [
  "callOp",
  "runFixCycle",
  "recordGreen",
  "captureGitRef",
  "buildResumePlan",
  "captureTreeState",
];

let savedDeps: Partial<Record<StoryDepsKey, unknown>> | undefined;

beforeEach(() => {
  savedDeps = {};
  for (const key of STORY_DEPS_KEYS) {
    savedDeps[key] = _storyOrchestratorDeps[key];
  }
  // Kill real git subprocesses for the whole file: tree captures degrade to sentinels.
  _storyOrchestratorDeps.captureTreeState = async () => ({ headSha: "test-head", dirtyDigest: "test-dirty" });
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});

afterEach(() => {
  if (!savedDeps) return;
  const snapshot = savedDeps;
  savedDeps = undefined;
  for (const key of STORY_DEPS_KEYS) {
    // biome-ignore lint/suspicious/noExplicitAny: deps seam restore — each slot has its own function type
    (_storyOrchestratorDeps as Record<string, unknown>)[key] = snapshot[key] as any;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — shouldRunReviewsConcurrently (AC-1 … AC-8)
// ─────────────────────────────────────────────────────────────────────────────

describe("parallel-review-pair US-001 — shouldRunReviewsConcurrently", () => {
  test("AC-1: parallel=true, maxConcurrentSessions=2, both review phases → exactly true", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    const result = shouldRunReviewsConcurrently(
      { adversarial: { parallel: true, maxConcurrentSessions: 2 } },
      ["semantic-review", "adversarial-review"],
    );
    expect(result).toBe(true);
  });

  test("AC-2: parallel=false → exactly false for maxConcurrentSessions 1, 2 and undefined", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    for (const maxConcurrentSessions of [1, 2, undefined]) {
      const result = shouldRunReviewsConcurrently(
        { adversarial: { parallel: false, maxConcurrentSessions } },
        ["semantic-review", "adversarial-review"],
      );
      expect(result).toBe(false);
    }
  });

  test("AC-3: parallel=true, maxConcurrentSessions=1 → exactly false", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    const result = shouldRunReviewsConcurrently(
      { adversarial: { parallel: true, maxConcurrentSessions: 1 } },
      ["semantic-review", "adversarial-review"],
    );
    expect(result).toBe(false);
  });

  test("AC-4: undefined reviewConfig → exactly false and no exception thrown", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    let result: boolean | undefined;
    expect(() => {
      result = shouldRunReviewsConcurrently(undefined, ["semantic-review", "adversarial-review"]);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  test("AC-5: adversarial key absent/undefined → exactly false", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    expect(
      shouldRunReviewsConcurrently({ adversarial: undefined }, ["semantic-review", "adversarial-review"]),
    ).toBe(false);
    expect(shouldRunReviewsConcurrently({}, ["semantic-review", "adversarial-review"])).toBe(false);
  });

  test("AC-6: parallel=true with maxConcurrentSessions missing → exactly true (schema default 2)", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    const result = shouldRunReviewsConcurrently(
      { adversarial: { parallel: true } },
      ["semantic-review", "adversarial-review"],
    );
    expect(result).toBe(true);
  });

  test("AC-7: phases lack adversarial-review → exactly false", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    const result = shouldRunReviewsConcurrently(
      { adversarial: { parallel: true, maxConcurrentSessions: 2 } },
      ["semantic-review"],
    );
    expect(result).toBe(false);
  });

  test("AC-8: phases lack semantic-review → exactly false", async () => {
    const { shouldRunReviewsConcurrently } = await loadReviewPair();
    const result = shouldRunReviewsConcurrently(
      { adversarial: { parallel: true, maxConcurrentSessions: 2 } },
      ["adversarial-review"],
    );
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — runReviewPair (AC-9 … AC-16)
// ─────────────────────────────────────────────────────────────────────────────

describe("parallel-review-pair US-001 — runReviewPair", () => {
  test("AC-9: dispatches runPhase for both reviews before either stub promise settles", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac9");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const stubCalls: string[] = [];

    await withPairRunPhaseStub((...args: unknown[]) => {
      stubCalls.push(phaseNameOf(args[1]));
      return makeDeferred<unknown>().promise; // never settles
    }, async (runReviewPair) => {
      void runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
      await flushTurns(3);

      // Asserted while BOTH stub promises are still pending.
      expect(stubCalls).toHaveLength(2);
      expect(stubCalls.filter((name) => name === "semantic-review")).toHaveLength(1);
      expect(stubCalls.filter((name) => name === "adversarial-review")).toHaveLength(1);
    });
  });

  test("AC-10: each review's sentinel output lands under its own phaseOutputs key", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac10");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const sentinels: Record<string, Record<string, unknown>> = {
      "semantic-review": { sentinel: "semantic-output" },
      "adversarial-review": { sentinel: "adversarial-output" },
    };

    await withPairRunPhaseStub(async (...args: unknown[]) => {
      const name = phaseNameOf(args[1]);
      tracking.phaseOutputs[name] = sentinels[name];
      return sentinels[name];
    }, async (runReviewPair) => {
      await runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
    });

    expect(tracking.phaseOutputs["semantic-review"]).toBeDefined();
    expect(tracking.phaseOutputs["semantic-review"]).toBe(sentinels["semantic-review"]);
    expect(tracking.phaseOutputs["adversarial-review"]).toBeDefined();
    expect(tracking.phaseOutputs["adversarial-review"]).toBe(sentinels["adversarial-review"]);
  });

  test("AC-11: each review's cost lands under its own phaseCosts key without clobbering", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac11");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const costs: Record<string, number> = { "semantic-review": 0.5, "adversarial-review": 0.7 };

    await withPairRunPhaseStub(async (...args: unknown[]) => {
      const name = phaseNameOf(args[1]);
      tracking.phaseCosts[name] = costs[name];
      return { ...PASS_REVIEW };
    }, async (runReviewPair) => {
      await runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
    });

    expect(tracking.phaseCosts["semantic-review"]).toBe(0.5);
    expect(tracking.phaseCosts["adversarial-review"]).toBe(0.7);
  });

  test("AC-12: does not settle while a sibling review promise is still pending", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac12");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const e1 = new Error("semantic-fail");
    const semanticDeferred = makeDeferred<unknown>();
    semanticDeferred.reject(e1); // semantic-review rejects immediately
    const adversarialDeferred = makeDeferred<unknown>(); // adversarial-review held pending

    await withPairRunPhaseStub((...args: unknown[]) => {
      return phaseNameOf(args[1]) === "semantic-review" ? semanticDeferred.promise : adversarialDeferred.promise;
    }, async (runReviewPair) => {
      let settledState: string | null = null;
      const resultPromise = runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
      // Spy on the returned promise's settlement (both handlers → no unhandled rejection).
      void resultPromise.then(
        () => {
          settledState = "resolved";
        },
        () => {
          settledState = "rejected";
        },
      );

      await flushTurns(3);
      // adversarial-review is still pending → runReviewPair must be unsettled.
      expect(settledState).toBe(null);

      adversarialDeferred.resolve({ ...PASS_REVIEW });
      await resultPromise.catch(() => {});

      // The spy fired only after the adversarial deferred settled.
      expect(settledState).toBe("rejected");
    });
  });

  test("AC-13: semantic-review rejects, adversarial-review succeeds → rejects with exactly the semantic error", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac13");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const e1 = new Error("semantic-fail");

    await withPairRunPhaseStub((...args: unknown[]) => {
      return phaseNameOf(args[1]) === "semantic-review" ? Promise.reject(e1) : Promise.resolve({ ...PASS_REVIEW });
    }, async (runReviewPair) => {
      let caught: unknown = "unset";
      try {
        await runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(e1);
    });
  });

  test("AC-14: both reviews reject → rejects with exactly E1 and never with E2", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac14");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const e1 = new Error("semantic-fail");
    const e2 = new Error("adversarial-fail");

    await withPairRunPhaseStub((...args: unknown[]) => {
      const name = phaseNameOf(args[1]);
      return name === "semantic-review" ? Promise.reject(e1) : Promise.reject(e2);
    }, async (runReviewPair) => {
      let caught: unknown = "unset";
      try {
        await runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(e1);
      expect(caught).not.toBe(e2);
    });
  });

  test("AC-15: logs exactly one error per throwing phase with storyId as the first context key", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac15");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };

    await withErrorSpy(async (errorCalls) => {
      await withPairRunPhaseStub(
        (...args: unknown[]) => Promise.reject(new Error(`boom: ${phaseNameOf(args[1])}`)),
        async (runReviewPair) => {
          await runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking).catch(() => {});
        },
      );

      expect(errorCalls).toHaveLength(2);
      const phasesSeen = errorCalls.map((call) => (call[2] as { phase?: string } | undefined)?.phase);
      expect(phasesSeen).toContain("semantic-review");
      expect(phasesSeen).toContain("adversarial-review");
      for (const call of errorCalls) {
        expect(call[1]).toBe("Phase threw unexpected error");
        const data = call[2];
        expect(data).toBeDefined();
        expect(Object.keys(data as Record<string, unknown>)[0]).toBe("storyId");
      }
    });
  });

  test("AC-16: logs exactly one concurrency info line under stage story-orchestrator", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-pair-ac16");
    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const MESSAGE = "Running semantic-review and adversarial-review concurrently";

    await withInfoSpy(async (infoSpy) => {
      await withPairRunPhaseStub(async () => ({ ...PASS_REVIEW }), async (runReviewPair) => {
        await runReviewPair(ctx, ["semantic-review", "adversarial-review"], tracking);
      });

      const matching = infoSpy.mock.calls.filter((call) => call[1] === MESSAGE);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.[0]).toBe("story-orchestrator");
      const data = matching[0]?.[2];
      expect(data).toBeDefined();
      expect(Object.keys(data as Record<string, unknown>)[0]).toBe("storyId");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — canonical loop / ExecutionPlan.run (AC-17 … AC-32)
// ─────────────────────────────────────────────────────────────────────────────

describe("parallel-review-pair US-002 — ExecutionPlan.run dispatch", () => {
  test("AC-17: parallel=true run() to completion dispatches each review exactly once", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac17");
    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    await makeReviewPairPlan(ctx).run();

    expect(countCalls(tracker.calls, "semantic-review")).toBe(1);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(1);
  });

  test("AC-18: parallel=true starts both review dispatches while both deferreds are pending", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac18");
    const tracker = makeTrackedCallOp({ hold: ["semantic-review", "adversarial-review"] });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    let settled = false;
    const runPromise = makeReviewPairPlan(ctx)
      .run()
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

    await flushTurns(3);
    const bothDispatched = await untilTrue(
      () => countCalls(tracker.calls, "semantic-review") === 1 && countCalls(tracker.calls, "adversarial-review") === 1,
    );
    expect(bothDispatched).toBe(true);
    // Both deferred promises are still pending — run() must not have settled.
    expect(settled).toBe(false);

    for (const deferred of tracker.deferreds.values()) deferred.resolve({ ...PASS_REVIEW });
    await runPromise;
    expect(settled).toBe(true);
  });

  test("AC-19: parallel=true with semantic-review seeded passing → exactly 1 adversarial-review call", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac19");
    _storyOrchestratorDeps.buildResumePlan = async () => ({
      skipPhases: ["semantic-review"],
      revalidateGates: [],
      reason: "resume",
    });
    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    await makeReviewPairPlan(ctx).run();

    expect(countCalls(tracker.calls, "adversarial-review")).toBe(1);
  });

  test("AC-20: parallel=true with semantic-review seeded passing → 0 semantic-review calls", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac20");
    _storyOrchestratorDeps.buildResumePlan = async () => ({
      skipPhases: ["semantic-review"],
      revalidateGates: [],
      reason: "resume",
    });
    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    await makeReviewPairPlan(ctx).run();

    expect(countCalls(tracker.calls, "semantic-review")).toBe(0);
  });

  test("AC-21: parallel=false → adversarial-review dispatched only after semantic-review resolves", async () => {
    const ctx = makeCtxWithConfig(parallelOffConfig(), "US-loop-ac21");
    const tracker = makeTrackedCallOp({ hold: ["semantic-review"] });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    let settled = false;
    const runPromise = makeReviewPairPlan(ctx)
      .run()
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

    await flushTurns(3);
    const semanticDispatched = await untilTrue(() => countCalls(tracker.calls, "semantic-review") === 1);
    expect(semanticDispatched).toBe(true);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(0);

    tracker.deferreds.get("semantic-review")?.resolve({ ...PASS_REVIEW });
    await runPromise;
    expect(settled).toBe(true);
    const adversarialDispatched = await untilTrue(() => countCalls(tracker.calls, "adversarial-review") === 1);
    expect(adversarialDispatched).toBe(true);
  });

  test("AC-22: parallel=true with maxConcurrentSessions=1 → adversarial-review only after semantic-review resolves", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig({ maxConcurrentSessions: 1 }), "US-loop-ac22");
    const tracker = makeTrackedCallOp({ hold: ["semantic-review"] });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    let settled = false;
    const runPromise = makeReviewPairPlan(ctx)
      .run()
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

    await flushTurns(3);
    const semanticDispatched = await untilTrue(() => countCalls(tracker.calls, "semantic-review") === 1);
    expect(semanticDispatched).toBe(true);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(0);

    tracker.deferreds.get("semantic-review")?.resolve({ ...PASS_REVIEW });
    await runPromise;
    expect(settled).toBe(true);
    const adversarialDispatched = await untilTrue(() => countCalls(tracker.calls, "adversarial-review") === 1);
    expect(adversarialDispatched).toBe(true);
  });
});

describe("parallel-review-pair US-002 — runCanonicalLoop outcomes", () => {
  test("AC-23: semantic-review failing + adversarial-review passing → { shortCircuitPhase: 'semantic-review' }", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac23");
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    }).callOp;

    const result = await runLoopWith(ctx, reviewPairPhases());
    expect(result).toEqual({ shortCircuitPhase: "semantic-review" });
  });

  test("AC-24: semantic-review failing under concurrency logs the second-opinion warning", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac24");
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    }).callOp;

    await withWarnSpy(async (warnSpy) => {
      await runLoopWith(ctx, reviewPairPhases());
      const warning = warnSpy.mock.calls.find(
        (call) =>
          typeof call[1] === "string" &&
          call[1].includes("semantic-review failed — continuing to adversarial-review for a second opinion"),
      );
      expect(warning).toBeDefined();
    });
  });

  test("AC-25: both reviews failing → { shortCircuitPhase: 'adversarial-review' }", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac25");
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: {
        "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS),
        "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]),
      },
    }).callOp;

    const result = await runLoopWith(ctx, reviewPairPhases());
    expect(result).toEqual({ shortCircuitPhase: "adversarial-review" });
  });

  test("AC-26: semantic failing + adversarial passing → recordGreen exactly once for adversarial-review", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac26");
    const greens: string[] = [];
    _storyOrchestratorDeps.recordGreen = (async (_storyId: string, phase: string) => {
      greens.push(phase);
    }) as typeof _storyOrchestratorDeps.recordGreen;
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    }).callOp;

    await runLoopWith(ctx, reviewPairPhases());

    expect(countCalls(greens, "adversarial-review")).toBe(1);
    expect(countCalls(greens, "semantic-review")).toBe(0);
  });

  test("AC-27: both reviews passing → recordGreen semantic-review first, adversarial-review second", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac27");
    const greens: string[] = [];
    _storyOrchestratorDeps.recordGreen = (async (_storyId: string, phase: string) => {
      greens.push(phase);
    }) as typeof _storyOrchestratorDeps.recordGreen;
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({}).callOp;

    await runLoopWith(ctx, reviewPairPhases());

    expect(greens).toHaveLength(2);
    expect(greens[0]).toBe("semantic-review");
    expect(greens[1]).toBe("adversarial-review");
  });

  test("AC-28: semantic-review passing + adversarial-review failing → { shortCircuitPhase: 'adversarial-review' }", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac28");
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]) },
    }).callOp;

    const result = await runLoopWith(ctx, reviewPairPhases());
    expect(result).toEqual({ shortCircuitPhase: "adversarial-review" });
  });

  test("AC-29: semantic passing + adversarial failing → recordGreen exactly once for semantic-review", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac29");
    const greens: string[] = [];
    _storyOrchestratorDeps.recordGreen = (async (_storyId: string, phase: string) => {
      greens.push(phase);
    }) as typeof _storyOrchestratorDeps.recordGreen;
    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]) },
    }).callOp;

    await runLoopWith(ctx, reviewPairPhases());

    expect(countCalls(greens, "semantic-review")).toBe(1);
    expect(countCalls(greens, "adversarial-review")).toBe(0);
  });

  test("AC-30: semantic-review callOp rejects → recordGreen(adversarial) event precedes the rejection", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac30");
    const events: string[] = [];
    _storyOrchestratorDeps.recordGreen = (async (_storyId: string, phase: string) => {
      events.push(`recordGreen:${phase}`);
    }) as typeof _storyOrchestratorDeps.recordGreen;

    const semanticDeferred = makeDeferred<Record<string, unknown>>();
    semanticDeferred.reject(new Error("semantic-fail"));
    _storyOrchestratorDeps.callOp = (async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "semantic-review") return semanticDeferred.promise;
      return { ...PASS_REVIEW };
    }) as typeof _storyOrchestratorDeps.callOp;

    let rejected = false;
    try {
      await runLoopWith(ctx, reviewPairPhases());
    } catch {
      rejected = true;
      events.push("rejection");
    }

    expect(rejected).toBe(true);
    expect(events).toEqual(["recordGreen:adversarial-review", "rejection"]);
  });

  test("AC-31: adversarial-review callOp rejects → recordGreen(semantic) event precedes the rejection", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac31");
    const events: string[] = [];
    _storyOrchestratorDeps.recordGreen = (async (_storyId: string, phase: string) => {
      events.push(`recordGreen:${phase}`);
    }) as typeof _storyOrchestratorDeps.recordGreen;

    const adversarialDeferred = makeDeferred<Record<string, unknown>>();
    adversarialDeferred.reject(new Error("adversarial-fail"));
    _storyOrchestratorDeps.callOp = (async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "adversarial-review") return adversarialDeferred.promise;
      return { ...PASS_REVIEW };
    }) as typeof _storyOrchestratorDeps.callOp;

    let rejected = false;
    try {
      await runLoopWith(ctx, reviewPairPhases());
    } catch {
      rejected = true;
      events.push("rejection");
    }

    expect(rejected).toBe(true);
    expect(events).toEqual(["recordGreen:semantic-review", "rejection"]);
  });

  test("AC-32: a rejecting review callOp logs 'Phase threw unexpected error' exactly once across all levels", async () => {
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-loop-ac32");
    const semanticDeferred = makeDeferred<Record<string, unknown>>();
    semanticDeferred.reject(new Error("semantic-fail"));
    _storyOrchestratorDeps.callOp = (async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "semantic-review") return semanticDeferred.promise;
      return { ...PASS_REVIEW };
    }) as typeof _storyOrchestratorDeps.callOp;

    let rejected = false;
    await withAllLevelsCapture(async (logs) => {
      try {
        await runLoopWith(ctx, reviewPairPhases());
      } catch {
        rejected = true;
      }
      const occurrences = logs.filter((log) => log.message === "Phase threw unexpected error");
      expect(occurrences).toHaveLength(1);
    });
    expect(rejected).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — revalidation sweep (AC-33 … AC-47)
// ─────────────────────────────────────────────────────────────────────────────

interface SweepHarness {
  cycle: FixCycle<Finding>;
  cycleCtx: FixCycleContext;
}

/**
 * Run a sweep plan to completion with the canonical loop failing semantic-review
 * (the standard rectification-seeding setup), capture the FixCycle handed to
 * `_storyOrchestratorDeps.runFixCycle`, and return it for manual validate() calls.
 */
async function harnessRevalidationSweep(opts: {
  config: NaxConfig;
  storyId: string;
  isThreeSession?: boolean;
  /** Output overrides for the canonical-loop stage (defaults: everything passes). */
  canonicalOutputs?: Record<string, Record<string, unknown>>;
  /** When supplied, the runtime signal is this controller's and aborts during the fix call. */
  abortController?: AbortController;
}): Promise<SweepHarness> {
  const runtime: NaxRuntime = makeTestRuntime({ config: opts.config });
  if (opts.abortController) {
    Object.defineProperty(runtime, "signal", {
      value: opts.abortController.signal,
      configurable: true,
    });
  }
  const ctx = makeMockCallContext({ runtime, config: opts.config, storyId: opts.storyId });

  const canonicalTracker = makeTrackedCallOp({ outputs: opts.canonicalOutputs });
  _storyOrchestratorDeps.callOp = canonicalTracker.callOp;

  let captured: SweepHarness | null = null;
  _storyOrchestratorDeps.runFixCycle = (async (cycle: FixCycle<Finding>, cycleCtx: FixCycleContext) => {
    if (!captured) captured = { cycle, cycleCtx };
    // Simulates the abort firing while the fix op is in flight.
    opts.abortController?.abort();
    return makeFixCycleResult<Finding>();
  }) as typeof _storyOrchestratorDeps.runFixCycle;

  await makeSweepPlan(ctx, { isThreeSession: opts.isThreeSession }).run();
  if (!captured) {
    throw new Error("runFixCycle was never invoked — the canonical loop did not seed rectification findings");
  }
  return captured;
}

/** Normalizes a validate() result to the { findings, shortCircuited } object shape. */
function asValidateResult(result: unknown): { findings: Finding[]; shortCircuited?: boolean } {
  if (Array.isArray(result)) return { findings: result as Finding[] };
  return result as { findings: Finding[]; shortCircuited?: boolean };
}

describe("parallel-review-pair US-003 — revalidation sweep dispatch", () => {
  test("AC-33: parallel=true sweep starts both review dispatches while both are pending", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac33",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    const tracker = makeTrackedCallOp({ hold: ["semantic-review", "adversarial-review"] });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    const validatePromise = cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });
    await flushTurns(3);
    const bothDispatched = await untilTrue(
      () => countCalls(tracker.calls, "semantic-review") === 1 && countCalls(tracker.calls, "adversarial-review") === 1,
    );

    // Asserted while BOTH dispatch promises are still pending.
    expect(bothDispatched).toBe(true);

    for (const deferred of tracker.deferreds.values()) deferred.resolve({ ...PASS_REVIEW });
    await validatePromise;
  });

  test("AC-34: parallel=false sweep dispatches adversarial-review strictly after semantic-review resolves", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOffConfig(),
      storyId: "US-sweep-ac34",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    const tracker = makeTrackedCallOp({ hold: ["semantic-review"] });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    const validatePromise = cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });
    await flushTurns(3);
    const semanticDispatched = await untilTrue(() => countCalls(tracker.calls, "semantic-review") === 1);

    expect(semanticDispatched).toBe(true);
    const semanticIndex = tracker.calls.indexOf("semantic-review");
    expect(tracker.calls.indexOf("adversarial-review")).toBe(-1);

    // Resolve the semantic-review callOp promise — only then may adversarial-review dispatch.
    tracker.deferreds.get("semantic-review")?.resolve({ ...PASS_REVIEW });
    const adversarialDispatched = await untilTrue(() => countCalls(tracker.calls, "adversarial-review") === 1);
    expect(adversarialDispatched).toBe(true);
    expect(tracker.calls.indexOf("adversarial-review")).toBeGreaterThan(semanticIndex);

    await validatePromise;
  });

  test("AC-35: parallel=false sweep with semantic-review failing → zero adversarial-review dispatches", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOffConfig(),
      storyId: "US-sweep-ac35",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    const tracker = makeTrackedCallOp({
      outputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    // The sweep ran (semantic dispatched once) and broke before the second reviewer.
    expect(countCalls(tracker.calls, "semantic-review")).toBe(1);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(0);
  });
});

describe("parallel-review-pair US-003 — sweep findings collection", () => {
  test("AC-36: parallel=true both reviews failing → validate returns semantic-review fixture findings", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac36",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: {
        "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS),
        "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]),
      },
    }).callOp;

    const result = asValidateResult(
      await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] }),
    );

    const semanticFindings = result.findings.filter(
      (finding) => finding.source === "semantic-review" && finding.message === "SEM-FIXTURE-1 unhandled null path",
    );
    expect(semanticFindings.length).toBeGreaterThanOrEqual(1);
  });

  test("AC-37: parallel=true both reviews failing → validate returns adversarial-review fixture findings", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac37",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: {
        "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS),
        "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]),
      },
    }).callOp;

    const result = asValidateResult(
      await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] }),
    );

    const adversarialFindings = result.findings.filter(
      (finding) =>
        finding.source === "adversarial-review" && finding.message === "ADV-FIXTURE-1 missing error-path coverage",
    );
    expect(adversarialFindings.length).toBeGreaterThanOrEqual(1);
  });

  test("AC-38: parallel=true both reviews failing → validate returns shortCircuited strictly true", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac38",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: {
        "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS),
        "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]),
      },
    }).callOp;

    const result = asValidateResult(
      await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] }),
    );

    expect(result.shortCircuited).toBe(true);
  });

  test("AC-39: parallel=true semantic failing + adversarial passing → shortCircuited strictly true", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac39",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    }).callOp;

    const result = asValidateResult(
      await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] }),
    );

    expect(result.shortCircuited).toBe(true);
  });

  test("AC-40: parallel=true semantic failing + adversarial passing → only semantic-review findings, exact count", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac40",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    _storyOrchestratorDeps.callOp = makeTrackedCallOp({
      outputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    }).callOp;

    const result = asValidateResult(
      await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] }),
    );

    expect(result.findings.every((finding) => finding.source === "semantic-review")).toBe(true);
    expect(result.findings.some((finding) => finding.source === "adversarial-review")).toBe(false);
    expect(result.findings).toHaveLength(SEMANTIC_FIXTURE_FINDINGS.length);
  });
});

describe("parallel-review-pair US-003 — sweep edges", () => {
  test("AC-41: isThreeSession + autofix-test-writer sweep dispatches adversarial-review alone", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac41",
      isThreeSession: true,
      // adversarial-review fails with a test-target finding; semantic-review passes.
      canonicalOutputs: {
        "adversarial-review": failReviewEnvelope([ADVERSARIAL_FIXTURE_FINDING]),
      },
    });

    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    // autofix-test-writer is the only strategy that registers in a three-session plan;
    // its revalidation set contains adversarial-review but NOT semantic-review.
    await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-test-writer"] });

    expect(countCalls(tracker.calls, "adversarial-review")).toBe(1);
    expect(countCalls(tracker.calls, "semantic-review")).toBe(0);
  });

  test("AC-42: parallel=true sweep with lint-check failing → neither review dispatched", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac42",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    const tracker = makeTrackedCallOp({ outputs: { "lint-check": LINT_FAILING_OUTPUT } });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    expect(countCalls(tracker.calls, "semantic-review")).toBe(0);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(0);
  });

  test("AC-43: signal aborted while the fix call is in flight → sweep dispatches neither review", async () => {
    const abortController = new AbortController();
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac43",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
      abortController,
    });
    expect(abortController.signal.aborted).toBe(true);

    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    await cycle.validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    expect(countCalls(tracker.calls, "semantic-review")).toBe(0);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(0);
  });

  test("AC-44: runRectification with an already-aborted signal returns {} and dispatches no review", async () => {
    const config = parallelOnConfig();
    const runtime = makeTestRuntime({ config });
    const abortController = new AbortController();
    Object.defineProperty(runtime, "signal", { value: abortController.signal, configurable: true });
    abortController.abort(); // already aborted on entry
    const ctx = makeMockCallContext({ runtime, config, storyId: "US-abort-rect" });

    const state: InternalBuildState = {
      semanticReview: {
        kind: "semantic-review",
        slot: { op: makeOrchestratorOp("semantic-review", "review", "reviewer-semantic"), input: {} },
      },
      adversarialReview: {
        kind: "adversarial-review",
        slot: { op: makeOrchestratorOp("adversarial-review", "review", "reviewer-adversarial"), input: {} },
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    };

    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    const result = await runRectification(ctx, state, {}, {});

    expect(result).toEqual({});
    expect(countCalls(tracker.calls, "semantic-review")).toBe(0);
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(0);
    expect(tracker.calls).toHaveLength(0);
  });

  test("AC-45: lite sweep with parallel=true dispatches full-suite-gate after both reviews resolved", async () => {
    const { cycle, cycleCtx } = await harnessRevalidationSweep({
      config: parallelOnConfig(),
      storyId: "US-sweep-ac45",
      canonicalOutputs: { "semantic-review": failReviewEnvelope(SEMANTIC_FIXTURE_FINDINGS) },
    });

    const tracker = makeTrackedCallOp({ hold: ["semantic-review", "adversarial-review"] });
    _storyOrchestratorDeps.callOp = tracker.callOp;

    const validatePromise = cycle.validate(cycleCtx, { mode: "lite", strategiesRun: ["autofix-implementer"] });
    await flushTurns(3);
    const reviewsDispatched = await untilTrue(
      () => countCalls(tracker.calls, "semantic-review") === 1 && countCalls(tracker.calls, "adversarial-review") === 1,
    );

    expect(reviewsDispatched).toBe(true);
    // The gate is the terminal lite arbiter: it must NOT run while the reviews are pending.
    expect(countCalls(tracker.calls, "full-suite-gate")).toBe(0);
    const semanticIndex = tracker.calls.indexOf("semantic-review");
    const adversarialIndex = tracker.calls.indexOf("adversarial-review");

    // Both review callOp promises resolve before the gate may be invoked.
    for (const deferred of tracker.deferreds.values()) deferred.resolve({ ...PASS_REVIEW });
    const gateDispatched = await untilTrue(() => countCalls(tracker.calls, "full-suite-gate") === 1);
    expect(gateDispatched).toBe(true);

    const gateIndex = tracker.calls.indexOf("full-suite-gate");
    expect(gateIndex).toBeGreaterThan(semanticIndex);
    expect(gateIndex).toBeGreaterThan(adversarialIndex);

    await validatePromise;
  });
});

describe("parallel-review-pair US-003 — dispatchRevalidationPhase", () => {
  test("AC-46: parallel=true semantic-review dispatch returns exactly ['semantic-review','adversarial-review']", async () => {
    const { dispatchRevalidationPhase } = await loadRevalidationReviews();
    const ctx = makeCtxWithConfig(parallelOnConfig(), "US-sweep-ac46");
    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
    const phases = ["semantic-review", "adversarial-review"];
    const dispatched = await dispatchRevalidationPhase(ctx, "semantic-review", phases, tracking);

    expect(dispatched).toHaveLength(2);
    expect(dispatched).toEqual(["semantic-review", "adversarial-review"]);
  });

  test("AC-47: parallel=false dispatch returns exactly [P] for every sampled phase", async () => {
    const { dispatchRevalidationPhase } = await loadRevalidationReviews();
    const ctx = makeCtxWithConfig(parallelOffConfig(), "US-sweep-ac47");
    const tracker = makeTrackedCallOp({});
    _storyOrchestratorDeps.callOp = tracker.callOp;

    const sweepPhases = ["semantic-review", "adversarial-review", "lint-check", "full-suite-gate"];
    for (const phase of sweepPhases) {
      const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: {} };
      const dispatched = await dispatchRevalidationPhase(ctx, phase, sweepPhases, tracking);
      expect(dispatched).toHaveLength(1);
      expect(dispatched).toEqual([phase]);
    }
    // No adversarial-review kind was ever added on top of a sampled phase.
    expect(countCalls(tracker.calls, "adversarial-review")).toBe(1);
  });
});