/**
 * US-003 — the revalidation sweep runs the review pair (AC1–AC13).
 *
 * `ExecutionPlan.run()` reaches rectification, whose validate sweep re-dispatches
 * the phases the fixing strategy touches. This file drives that sweep through the
 * `FixCycle` captured from `_storyOrchestratorDeps.runFixCycle` (the seam
 * `story-orchestrator-revalidation.test.ts` established) and asserts on the
 * `callOp` dispatches it makes:
 *
 *  - with `review.adversarial.parallel: true` the sweep starts `semantic-review`
 *    and `adversarial-review` together, collects BOTH reviewers' findings before
 *    it short-circuits, and never pairs them when only one review is in scope;
 *  - with `parallel: false` the sweep stays strictly sequential (AC2, AC3);
 *  - the pre-existing guards still hold: an aborted run dispatches no review at
 *    all (AC11, AC12) and a cheaper failing phase short-circuits first (AC10);
 *  - lite mode still re-runs the full-suite gate — now after both reviews settled
 *    (AC13).
 *
 * Every boundary is mocked through `_storyOrchestratorDeps` (`callOp`, `runFixCycle`,
 * `captureTreeState`, `recordGreen`, `loadCheckpoints`, `buildResumePlan`,
 * `captureGitRef`), so nothing here shells out to git, touches disk or reaches a model.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  makeAdversarialOutput,
  makeCallOp,
  makeFinding,
  makeFixCycleResult,
  makeMockCallContext,
  makeNaxConfig,
  makeSemanticOutput,
  makeTestRuntime,
  waitForCondition,
  withDepsRestore,
  withTimeout,
} from "@test/helpers";
import { type NaxConfig, pickSelector } from "@/config";
import {
  _storyOrchestratorDeps,
  type InternalBuildState,
  type PhaseKind,
  runRectification,
  StoryOrchestratorBuilder,
  type TreeState,
} from "@/execution";
import type { InternalPhase } from "@/execution/story-orchestrator";
import type { Finding, FixCycle, FixCycleContext, FixCycleResult, ValidateResult } from "@/findings";
import type { CallContext, DeterministicOperation, Operation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ── fixtures ────────────────────────────────────────────────────────────────

const opSel = pickSelector("us003-revalidation-reviews-sel", "execution");
type OpConfig = ReturnType<(typeof opSel)["select"]>;

/** A synthetic tree state so `recordGreenCheckpoint` never runs git. */
const TREE: TreeState = { headSha: "us003-head", dirtyDigest: "us003-dirty" };

const PASS = { success: true, passed: true, findings: [] };

const SEM_MSG = "semantic: rename this field";
const ADV_MSG = "adversarial: the new branch is untested";

const SEM_FAILING_FINDING = makeFinding({ source: "semantic-review", severity: "error", message: SEM_MSG });
const ADV_FAILING_FINDING = makeFinding({ source: "adversarial-review", severity: "error", message: ADV_MSG });

const SEM_FAIL = makeSemanticOutput({ passed: false, normalizedFindings: [SEM_FAILING_FINDING] });
const ADV_FAIL = makeAdversarialOutput({ passed: false, normalizedFindings: [ADV_FAILING_FINDING] });
/** The adversarial finding `autofix-test-writer` claims: its fix lands in a test file. */
const ADV_FAIL_TEST_TARGET = makeAdversarialOutput({
  passed: false,
  normalizedFindings: [makeFinding({ ...ADV_FAILING_FINDING, fixTarget: "test" })],
});
const SEM_PASS = makeSemanticOutput({ passed: true });
const ADV_PASS = makeAdversarialOutput({ passed: true });
const LINT_FAIL = {
  success: false,
  findings: [
    makeFinding({ source: "lint", tool: "biome", severity: "error", message: "Unused variable", file: "src/foo.ts" }),
  ],
};

/**
 * The output each phase op returns during the `ExecutionPlan.run()` under test.
 * Reassigned per test so `execute` reads the current set — the ops are built once
 * and referenced by the plan, so this is the only way to vary their output.
 */
let phaseOutputsForTest: Record<string, unknown> = {};

function makePhaseOp(name: string): DeterministicOperation<unknown, unknown, OpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: opSel,
    execute: async () => phaseOutputsForTest[name] ?? PASS,
  };
}

const IMPLEMENTER_OP = makePhaseOp("implementer");
const GATE_OP = makePhaseOp("full-suite-gate");
const LINT_OP = makePhaseOp("lint-check");
const TYPECHECK_OP = makePhaseOp("typecheck-check");
const SEMANTIC_OP = makePhaseOp("semantic-review");
const ADVERSARIAL_OP = makePhaseOp("adversarial-review");

function makePlan(ctx: CallContext, isThreeSession = false) {
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: IMPLEMENTER_OP, input: {} })
    .addFullSuiteGate({ op: GATE_OP, input: {} })
    .addLintCheck({ op: LINT_OP, input: {} })
    .addTypecheckCheck({ op: TYPECHECK_OP, input: {} })
    .addSemanticReview({ op: SEMANTIC_OP, input: {} })
    .addAdversarialReview({ op: ADVERSARIAL_OP, input: {} })
    .addRectification({ maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false })
    .build(ctx, { isThreeSession });
}

function makePhase(kind: PhaseKind): InternalPhase {
  return { kind, slot: { op: makePhaseOp(kind), input: {} } };
}

function reviewConfig(parallel: boolean, maxConcurrentSessions = 2): NaxConfig {
  return makeNaxConfig({ review: { adversarial: { parallel, maxConcurrentSessions } } });
}

// ── lifecycle ───────────────────────────────────────────────────────────────

let runtime: NaxRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function makeCtx(config: NaxConfig, parentSignal?: AbortSignal): CallContext {
  runtime = makeTestRuntime({ config, parentSignal });
  return makeMockCallContext({ runtime, packageDir: "/tmp/us003", storyId: "US-003", config });
}

/** A runtime built here rather than in `makeCtx` — AC12 needs an already-aborted signal. */
function makeAbortedCtx(config: NaxConfig): CallContext {
  const abort = new AbortController();
  runtime = makeTestRuntime({ config, parentSignal: abort.signal });
  abort.abort();
  return makeMockCallContext({ runtime, packageDir: "/tmp/us003", storyId: "US-003", config });
}

/** Keep `ExecutionPlan.run()`'s resume/checkpoint plumbing away from git and disk. */
function installInertLoopDeps(): void {
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
  _storyOrchestratorDeps.captureTreeState = async () => TREE;
  _storyOrchestratorDeps.recordGreen = async () => {};
  _storyOrchestratorDeps.loadCheckpoints = async () => new Map();
  _storyOrchestratorDeps.buildResumePlan = async () => ({
    skipPhases: [],
    revalidateGates: [],
    reason: "no-checkpoint",
  });
}

// ── deferred callOp ─────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: (value) => resolveFn(value) };
}

interface OpHandle {
  /** Dispatch / resolution events for the deferred ops, in the order they happened. */
  events: string[];
  count(op: string): number;
  hasDispatched(op: string): boolean;
  resolveIfPending(op: string, output: unknown): void;
}

/**
 * A `callOp` stub for the validate sweep. Ops listed in `defer` hand back a
 * promise the test resolves by hand — that is what lets a test observe whether a
 * sibling review starts before the first one settles. Every other op resolves
 * immediately to `outputs[op.name] ?? PASS`.
 */
function installValidateCallOp(
  options: { defer?: readonly string[]; outputs?: Record<string, unknown> } = {},
): OpHandle {
  const deferredOps = new Set(options.defer ?? []);
  phaseOutputsForTest = options.outputs ?? {};
  const base = makeCallOp();
  const events: string[] = [];
  const counts: Record<string, number> = {};
  const pending = new Map<string, Deferred<unknown>>();

  _storyOrchestratorDeps.callOp = async <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    counts[op.name] = (counts[op.name] ?? 0) + 1;
    if (!deferredOps.has(op.name)) return base(ctx, op, input);
    events.push(`dispatch:${op.name}`);
    const deferred = makeDeferred<O>();
    pending.set(op.name, deferred);
    return deferred.promise.then((output) => {
      events.push(`resolve:${op.name}`);
      return output;
    });
  };

  return {
    events,
    count: (op) => counts[op] ?? 0,
    hasDispatched: (op) => events.includes(`dispatch:${op}`),
    resolveIfPending: (op, output) => {
      pending.get(op)?.resolve(output);
    },
  };
}

// ── capture ─────────────────────────────────────────────────────────────────

/** The revalidation sweep `FixCycle.validate` callback — signature taken from the cycle itself. */
type RevalidationValidate = FixCycle<Finding>["validate"];

interface CapturedSweep {
  /** `cycle.validate` of the cycle `runFixCycle` was handed, widened to `Finding`. */
  validate: RevalidationValidate;
  cycleCtx: FixCycleContext;
}

interface CaptureOptions {
  isThreeSession?: boolean;
  /** Outputs for the `ExecutionPlan.run()` that seeds rectification (reviews fail by default). */
  outputs?: Record<string, unknown>;
  /** Runs after the cycle is captured but before `run()` returns — e.g. to abort the run. */
  onCapture?: () => void | Promise<void>;
}

/**
 * Run the plan so rectification hands a `FixCycle` to `runFixCycle`, and hand back
 * its `validate` callback with the context to drive it. The plan's two reviews
 * fail, so the sweep has findings to seed the cycle with.
 */
async function captureCycle(ctx: CallContext, options: CaptureOptions = {}): Promise<CapturedSweep> {
  installInertLoopDeps();
  phaseOutputsForTest = options.outputs ?? { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL };
  _storyOrchestratorDeps.callOp = makeCallOp();

  const captured = makeDeferred<CapturedSweep>();
  let capturedOnce = false;
  // Generic arrow so the slot's `F` flows through — see makeFixCycleResult's header.
  _storyOrchestratorDeps.runFixCycle = async <F extends Finding>(
    cycle: FixCycle<F>,
    cycleCtx: FixCycleContext,
  ): Promise<FixCycleResult<F>> => {
    if (!capturedOnce) {
      capturedOnce = true;
      await options.onCapture?.();
      captured.resolve({ validate: cycle.validate, cycleCtx });
    }
    return makeFixCycleResult<F>();
  };

  await withTimeout(makePlan(ctx, options.isThreeSession ?? false).run(), 5_000, "ExecutionPlan.run");
  return withTimeout(captured.promise, 5_000, "FixCycle capture");
}

// ── assertions helpers ──────────────────────────────────────────────────────

function findingsOf(result: Finding[] | ValidateResult<Finding>): readonly Finding[] {
  return Array.isArray(result) ? result : result.findings;
}

function shortCircuitedOf(result: Finding[] | ValidateResult<Finding>): boolean | undefined {
  return Array.isArray(result) ? undefined : result.shortCircuited;
}

/** Non-throwing poll, so a missing dispatch surfaces as a failed expectation. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  return waitForCondition(predicate, timeoutMs).then(
    () => true,
    () => false,
  );
}

const SWEEP_STRATEGY = ["autofix-implementer"] as const;

// ── AC1–AC3: dispatch timing during revalidation ────────────────────────────

describe("revalidation sweep — review dispatch timing (US-003)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-003 AC1: with parallel true, both reviews start before either resolves", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    const handle = installValidateCallOp({ defer: ["semantic-review", "adversarial-review"] });

    const validatePromise = validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] });

    const bothDispatched = await waitFor(
      () => handle.count("semantic-review") === 1 && handle.count("adversarial-review") === 1,
    );
    // Snapshot before resolving anything: a sequential sweep only ever has one
    // review in flight, so this is what separates the pair from it.
    const inFlight = [...handle.events];

    expect(bothDispatched).toBe(true);
    expect(inFlight.sort()).toEqual(["dispatch:adversarial-review", "dispatch:semantic-review"]);

    handle.resolveIfPending("semantic-review", SEM_FAIL);
    handle.resolveIfPending("adversarial-review", ADV_FAIL);
    await withTimeout(validatePromise, 5_000, "cycle.validate");
  });

  test("US-003 AC2: with parallel false, adversarial-review starts only after semantic-review resolved", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(false)));
    const handle = installValidateCallOp({ defer: ["semantic-review", "adversarial-review"] });

    const validatePromise = validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] });

    expect(await waitFor(() => handle.hasDispatched("semantic-review"))).toBe(true);
    // Still gated: nothing may start the sibling review while the first is in flight.
    expect(handle.count("adversarial-review")).toBe(0);

    handle.resolveIfPending("semantic-review", SEM_PASS);
    expect(await waitFor(() => handle.hasDispatched("adversarial-review"))).toBe(true);
    handle.resolveIfPending("adversarial-review", ADV_PASS);

    await withTimeout(validatePromise, 5_000, "cycle.validate");

    expect(handle.events).toEqual([
      "dispatch:semantic-review",
      "resolve:semantic-review",
      "dispatch:adversarial-review",
      "resolve:adversarial-review",
    ]);
  });

  test("US-003 AC3: with parallel false and semantic-review failing, adversarial-review is never dispatched", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(false)));
    const handle = installValidateCallOp({
      outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL },
    });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(handle.count("semantic-review")).toBe(1);
    expect(handle.count("adversarial-review")).toBe(0);
    expect(shortCircuitedOf(result)).toBe(true);
  });
});

// ── AC4–AC8: findings collected from both reviewers ────────────────────────

describe("revalidation sweep — findings from both reviewers (US-003)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-003 AC4: with parallel true and both reviews failing, validate returns the semantic-review findings", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(findingsOf(result).map((finding) => finding.message)).toContain(SEM_MSG);
  });

  test("US-003 AC5: with parallel true and both reviews failing, validate returns the adversarial-review findings", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(findingsOf(result).map((finding) => finding.message)).toContain(ADV_MSG);
  });

  test("US-003 AC6: with parallel true and both reviews failing, validate reports shortCircuited", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(shortCircuitedOf(result)).toBe(true);
  });

  test("US-003 AC6 boundary: a single failing review in the pair still short-circuits the sweep", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_PASS } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(shortCircuitedOf(result)).toBe(true);
  });

  test("US-003 AC7: with parallel true, semantic failing and adversarial passing, validate reports shortCircuited", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_PASS } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(shortCircuitedOf(result)).toBe(true);
  });

  test("US-003 AC8: with parallel true, semantic failing and adversarial passing, validate returns only semantic findings", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_PASS } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    const findings = findingsOf(result);
    expect(findings.map((finding) => finding.source)).toEqual(["semantic-review"]);
    expect(findings.map((finding) => finding.message)).toEqual([SEM_MSG]);
  });
});

// ── AC9: the pair never forms when only one review is in scope ─────────────

describe("revalidation sweep — ineligible pair (US-003)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-003 AC9: a three-session plan's test-target adversarial finding revalidates adversarial-review alone", async () => {
    const ctx = makeCtx(reviewConfig(true));
    const { validate, cycleCtx } = await captureCycle(ctx, {
      isThreeSession: true,
      outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL_TEST_TARGET },
    });
    const handle = installValidateCallOp({ outputs: { "adversarial-review": ADV_FAIL_TEST_TARGET } });

    // `autofix-test-writer` is the strategy that claims a test-target adversarial
    // finding, and its revalidation set deliberately omits semantic-review.
    await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: ["autofix-test-writer"] }),
      5_000,
      "cycle.validate",
    );

    expect(handle.count("adversarial-review")).toBe(1);
    expect(handle.count("semantic-review")).toBe(0);
  });
});

// ── AC10–AC12: the pre-existing guards still hold ──────────────────────────

describe("revalidation sweep — guards (US-003)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-003 AC10: a failing lint-check short-circuits before either review is dispatched", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    const handle = installValidateCallOp({
      outputs: {
        "lint-check": LINT_FAIL,
        "semantic-review": SEM_FAIL,
        "adversarial-review": ADV_FAIL,
      },
    });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(handle.count("lint-check")).toBe(1);
    expect(handle.count("semantic-review")).toBe(0);
    expect(handle.count("adversarial-review")).toBe(0);
    expect(shortCircuitedOf(result)).toBe(true);
  });

  test("US-003 AC11: an aborted run dispatches neither review during revalidation", async () => {
    const abort = new AbortController();
    const ctx = makeCtx(reviewConfig(true), abort.signal);
    const { validate, cycleCtx } = await captureCycle(ctx, {
      onCapture: () => {
        // The fix op is dispatched by the cycle `runFixCycle` is driving; aborting
        // here is the "signal aborts while the fix op runs" case.
        abort.abort();
      },
    });
    const handle = installValidateCallOp({ outputs: { "semantic-review": SEM_FAIL, "adversarial-review": ADV_FAIL } });

    const result = await withTimeout(
      validate(cycleCtx, { mode: "full", strategiesRun: [...SWEEP_STRATEGY] }),
      5_000,
      "cycle.validate",
    );

    expect(handle.count("semantic-review")).toBe(0);
    expect(handle.count("adversarial-review")).toBe(0);
    expect(findingsOf(result)).toEqual([]);
  });

  test("US-003 AC12: runRectification returns an empty result when the signal is already aborted", async () => {
    installInertLoopDeps();
    const ctx = makeAbortedCtx(reviewConfig(true));
    const dispatched: string[] = [];
    _storyOrchestratorDeps.callOp = makeCallOp({ onDispatch: (op) => dispatched.push(op.name) });

    const state: InternalBuildState = {
      lintCheck: makePhase("lint-check"),
      semanticReview: makePhase("semantic-review"),
      adversarialReview: makePhase("adversarial-review"),
      rectification: { maxAttempts: 1, strategies: [], abortOnIncreasingFailures: false },
    };

    const result = await runRectification(ctx, state, {}, {});

    expect(result).toEqual({});
    expect(dispatched).toEqual([]);
  });
});

// ── AC13: lite mode still runs the gate, after both reviews ────────────────

describe("revalidation sweep — lite mode gate ordering (US-003)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-003 AC13: in lite mode the full-suite-gate is dispatched only after both reviews resolved", async () => {
    const { validate, cycleCtx } = await captureCycle(makeCtx(reviewConfig(true)));
    const handle = installValidateCallOp({
      defer: ["semantic-review", "adversarial-review", "full-suite-gate"],
    });

    const validatePromise = validate(cycleCtx, { mode: "lite", strategiesRun: ["full-suite-rectify"] });

    const reviewsDispatched = await waitFor(
      () => handle.hasDispatched("semantic-review") && handle.hasDispatched("adversarial-review"),
    );
    expect(reviewsDispatched).toBe(true);
    // The gate is the expensive arbiter and runs last: both reviews are still in
    // flight, so it must not have started yet.
    expect(handle.count("full-suite-gate")).toBe(0);

    handle.resolveIfPending("semantic-review", SEM_PASS);
    handle.resolveIfPending("adversarial-review", ADV_PASS);

    expect(await waitFor(() => handle.hasDispatched("full-suite-gate"))).toBe(true);
    handle.resolveIfPending("full-suite-gate", PASS);

    await withTimeout(validatePromise, 5_000, "cycle.validate");

    // The gate dispatch follows both resolves; the two reviews' own relative
    // order is not part of the contract, so only the ordering that matters is asserted.
    const gateDispatch = handle.events.indexOf("dispatch:full-suite-gate");
    expect(gateDispatch).toBeGreaterThan(handle.events.indexOf("resolve:semantic-review"));
    expect(gateDispatch).toBeGreaterThan(handle.events.indexOf("resolve:adversarial-review"));
  });
});
