/**
 * US-002 — `runCanonicalLoop` runs the review pair (AC7–AC16).
 *
 * With `review.adversarial.parallel: true` the canonical loop dispatches
 * `semantic-review` and `adversarial-review` through `runReviewPair`, skips the
 * separate `adversarial-review` iteration, then applies exactly the per-phase
 * evaluation the sequential loop applies: the semantic-failed second-opinion
 * warning, `recordGreen` for passing phases in canonical order (#1666), and
 * `adversarial-review` overriding `semantic-review` in `shortCircuitPhase` when
 * both fail. A rejecting review `callOp` still records green for its passing
 * sibling before the already-logged rejection propagates.
 *
 * The harness holds each review dispatch at a gate, so "both reviews were in
 * flight before either settled" — the pair — is observed, not assumed. Every
 * external boundary is mocked through `_storyOrchestratorDeps`, so no test here
 * shells out to git or reaches a model.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeCallOp,
  makeMockCallContext,
  makeNaxConfig,
  makeTestRuntime,
  waitForCondition,
  withDepsRestore,
  withTimeout,
} from "@test/helpers";
import { type NaxConfig, pickSelector } from "@/config";
import { _storyOrchestratorDeps, type InternalBuildState, type PhaseKind, type TreeState } from "@/execution";
import type { InternalPhase } from "@/execution/story-orchestrator";
import {
  type PhaseTracking,
  type PlanParams,
  runCanonicalLoop,
} from "@/execution/story-orchestrator/execution-plan-phases";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { CallContext, DeterministicOperation, Operation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ── fixtures ────────────────────────────────────────────────────────────────

const opSel = pickSelector("test-us002-canonical-loop-pair", "execution");
type OpConfig = ReturnType<(typeof opSel)["select"]>;

/** A synthetic tree state so `recordGreenCheckpoint` never runs git. */
const TREE: TreeState = { headSha: "us002-head", dirtyDigest: "us002-dirty" };

/** `review.adversarial.parallel` on, with room for the pair's two sessions. */
const PARALLEL_REVIEW_CONFIG = makeNaxConfig({
  review: { adversarial: { parallel: true, maxConcurrentSessions: 2 } },
});

const SECOND_OPINION_WARNING = "semantic-review failed — continuing to adversarial-review for a second opinion";
const UNEXPECTED_PHASE_ERROR = "Phase threw unexpected error";

const REVIEW_OPS = ["semantic-review", "adversarial-review"] as const;

type ReviewOutcome = { kind: "pass" } | { kind: "fail" } | { kind: "reject"; error: unknown };

interface PairOutcome {
  /** True when both reviews were dispatched before either was allowed to settle. */
  concurrent: boolean;
  shortCircuitPhase: string | undefined;
  rejection: unknown;
}

interface LoopHarness {
  plan: PlanParams;
  tracking: PhaseTracking;
  orderedPhases: readonly InternalPhase[];
  /** Phase names `_storyOrchestratorDeps.recordGreen` was called with, in order. */
  greens: string[];
  /** `callOp` dispatches per op name. */
  counts: Record<string, number>;
  /** Ordered trace of `dispatch:<op>` / `settle:<op>` / `green:<phase>`. */
  events: string[];
  /** Start the loop, observe whether the pair is concurrent, then settle it. */
  finish(): Promise<PairOutcome>;
}

function makeReviewPhase(kind: PhaseKind, passed: boolean): InternalPhase {
  const op: DeterministicOperation<unknown, unknown, OpConfig> = {
    kind: "deterministic",
    name: kind,
    stage: "verify",
    config: opSel,
    execute: async () => ({ success: passed, estimatedCostUsd: 0, durationMs: 0 }),
  };
  return { kind, slot: { op, input: {} } };
}

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function makeGate(): Gate {
  let releaseFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  return { promise, release: () => releaseFn() };
}

/**
 * Build the [semantic-review, adversarial-review] plan for `runCanonicalLoop`,
 * installing every `_storyOrchestratorDeps` override the loop touches. Each
 * review dispatch parks on a gate until `finish()` releases it.
 */
function startPairLoop(options: {
  semantic: ReviewOutcome;
  adversarial: ReviewOutcome;
  config?: NaxConfig;
  phaseOutputs?: Record<string, unknown>;
}): LoopHarness {
  const events: string[] = [];
  const counts: Record<string, number> = {};
  const greens: string[] = [];
  const outcomes: Record<string, ReviewOutcome> = {
    "semantic-review": options.semantic,
    "adversarial-review": options.adversarial,
  };
  const gates = new Map<string, Gate>();
  const released = new Set<string>();

  const base = makeCallOp();
  _storyOrchestratorDeps.callOp = async <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    counts[op.name] = (counts[op.name] ?? 0) + 1;
    events.push(`dispatch:${op.name}`);
    const outcome: ReviewOutcome | undefined =
      op.name === "semantic-review" || op.name === "adversarial-review" ? outcomes[op.name] : undefined;
    if (outcome === undefined) return base(ctx, op, input);

    const settleReview = (): Promise<O> => {
      events.push(`settle:${op.name}`);
      if (outcome.kind === "reject") throw outcome.error;
      return base(ctx, op, input);
    };
    // Released while this review was still parked: a sequential loop reaching
    // the sibling only after its predecessor settled gets here.
    if (released.has(op.name)) return settleReview();

    const gate = makeGate();
    gates.set(op.name, gate);
    return gate.promise.then(() => settleReview());
  };
  _storyOrchestratorDeps.captureTreeState = async () => TREE;
  _storyOrchestratorDeps.recordGreen = async (_storyId, phase) => {
    greens.push(phase);
    events.push(`green:${phase}`);
  };

  const ctx = makeMockCallContext({
    runtime,
    packageDir: "/tmp/us002",
    storyId: "US-002",
    config: options.config ?? PARALLEL_REVIEW_CONFIG,
  });
  const orderedPhases: InternalPhase[] = [
    makeReviewPhase("semantic-review", options.semantic.kind === "pass"),
    makeReviewPhase("adversarial-review", options.adversarial.kind === "pass"),
  ];
  const state: InternalBuildState = {};
  const plan: PlanParams = { ctx, state, isThreeSession: false };
  const tracking: PhaseTracking = { phaseCosts: {}, phaseOutputs: { ...(options.phaseOutputs ?? {}) } };

  const releaseAll = (): void => {
    for (const name of REVIEW_OPS) {
      released.add(name);
      gates.get(name)?.release();
    }
  };

  const finish = async (): Promise<PairOutcome> => {
    let result: { shortCircuitPhase: string | undefined } | undefined;
    let rejection: unknown;
    const runPromise = runCanonicalLoop(plan, tracking, orderedPhases).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        rejection = error;
      },
    );
    // Both reviews dispatched while both are still parked ⇒ the pair.
    const concurrent = await waitForCondition(() => REVIEW_OPS.every((name) => (counts[name] ?? 0) === 1), 300).then(
      () => true,
      () => false,
    );
    releaseAll();
    await withTimeout(runPromise, 5_000, "runCanonicalLoop");
    return { concurrent, shortCircuitPhase: result?.shortCircuitPhase, rejection };
  };

  return { plan, tracking, orderedPhases, greens, counts, events, finish };
}

// ── lifecycle ───────────────────────────────────────────────────────────────

let runtime: NaxRuntime | undefined;
let entries: LogEntry[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent", suppressConsole: true });
  entries = [];
  unsubscribe = addSink((entry) => entries.push(entry));
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = undefined;
  resetLogger();
  await runtime?.close();
  runtime = undefined;
});

function makeRuntime(): void {
  runtime = makeTestRuntime({ config: PARALLEL_REVIEW_CONFIG });
}

function logEntries(message: string): LogEntry[] {
  return entries.filter((entry) => entry.message === message);
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("runCanonicalLoop with the review pair (US-002)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-002 AC7: semantic-review failing with adversarial-review passing returns shortCircuitPhase 'semantic-review'", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "fail" }, adversarial: { kind: "pass" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(outcome.shortCircuitPhase).toBe("semantic-review");
    // The pair ran each review exactly once — the loop must not re-run the
    // `adversarial-review` iteration it already covered.
    expect(h.counts["semantic-review"]).toBe(1);
    expect(h.counts["adversarial-review"]).toBe(1);
  });

  test("US-002 AC8: semantic-review failing with adversarial-review passing logs the second-opinion warning once", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "fail" }, adversarial: { kind: "pass" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    const warnings = logEntries(SECOND_OPINION_WARNING);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe("warn");
    expect(warnings[0]?.stage).toBe("story-orchestrator");
    expect(warnings[0]?.data?.storyId).toBe("US-002");
    expect(warnings[0]?.data?.phase).toBe("semantic-review");
  });

  test("US-002 AC9: both reviews failing returns shortCircuitPhase 'adversarial-review'", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "fail" }, adversarial: { kind: "fail" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(outcome.shortCircuitPhase).toBe("adversarial-review");
    // Both failed, so the passing-skip guard cannot cover the sibling: a loop
    // that merely `continue`s would dispatch adversarial-review a second time.
    expect(h.counts["semantic-review"]).toBe(1);
    expect(h.counts["adversarial-review"]).toBe(1);
  });

  test("US-002 AC10: semantic-review failing with adversarial-review passing records green for adversarial-review only", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "fail" }, adversarial: { kind: "pass" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(h.greens).toEqual(["adversarial-review"]);
  });

  test("US-002 AC11: both reviews passing records green for semantic-review first and adversarial-review second", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "pass" }, adversarial: { kind: "pass" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(h.greens).toEqual(["semantic-review", "adversarial-review"]);
  });

  test("US-002 AC12: semantic-review passing with adversarial-review failing returns shortCircuitPhase 'adversarial-review'", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "pass" }, adversarial: { kind: "fail" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(outcome.shortCircuitPhase).toBe("adversarial-review");
  });

  test("US-002 AC13: semantic-review passing with adversarial-review failing records green for semantic-review only", async () => {
    makeRuntime();
    const h = startPairLoop({ semantic: { kind: "pass" }, adversarial: { kind: "fail" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(h.greens).toEqual(["semantic-review"]);
  });

  test("US-002 AC14: a rejecting semantic-review callOp records green for adversarial-review before the rejection propagates", async () => {
    makeRuntime();
    const error = new Error("semantic-review dispatch exploded");
    const h = startPairLoop({ semantic: { kind: "reject", error }, adversarial: { kind: "pass" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    // The rejection has already propagated by the time we assert, so a green
    // recorded here necessarily landed before it.
    expect(outcome.rejection).toBe(error);
    expect(h.greens).toEqual(["adversarial-review"]);
  });

  test("US-002 AC15: a rejecting adversarial-review callOp records green for semantic-review before the rejection propagates", async () => {
    makeRuntime();
    const error = new Error("adversarial-review dispatch exploded");
    const h = startPairLoop({ semantic: { kind: "pass" }, adversarial: { kind: "reject", error } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(outcome.rejection).toBe(error);
    expect(h.greens).toEqual(["semantic-review"]);
  });

  test("US-002 AC16: a rejecting review callOp does not log 'Phase threw unexpected error' a second time", async () => {
    makeRuntime();
    const error = new Error("semantic-review dispatch exploded");
    const h = startPairLoop({ semantic: { kind: "reject", error }, adversarial: { kind: "pass" } });

    const outcome = await h.finish();

    expect(outcome.concurrent).toBe(true);
    expect(outcome.rejection).toBe(error);
    // Both reviews were dispatched in flight — the pair, not the sequential
    // loop, is what logged the single failure below.
    expect(h.counts["semantic-review"]).toBe(1);
    expect(h.counts["adversarial-review"]).toBe(1);

    const threw = logEntries(UNEXPECTED_PHASE_ERROR);
    expect(threw).toHaveLength(1);
    expect(threw[0]?.data?.phase).toBe("semantic-review");
    expect(threw[0]?.data?.storyId).toBe("US-002");
  });
});
