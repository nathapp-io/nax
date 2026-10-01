/**
 * US-002 — the canonical loop runs the review pair (AC1–AC6).
 *
 * `ExecutionPlan.run()` with `review.adversarial.parallel: true` must dispatch
 * `semantic-review` and `adversarial-review` through one concurrent pair, while
 * every other configuration keeps the sequential dispatch — including the
 * `maxConcurrentSessions: 1` cap and a resume that already seeded
 * `semantic-review` green.
 *
 * Every external boundary is mocked through `_storyOrchestratorDeps`
 * (`callOp` / `recordGreen` / `captureTreeState` / `buildResumePlan`), so this
 * file never shells out to git and never reaches a model.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeAdversarialReviewConfig,
  makeCallOp,
  makeMockCallContext,
  makeNaxConfig,
  makeSemanticReviewConfig,
  makeStory,
  makeTestRuntime,
  waitForCondition,
  withDepsRestore,
  withTimeout,
} from "@test/helpers";
import { type NaxConfig, pickSelector } from "@/config";
import { _storyOrchestratorDeps, StoryOrchestratorBuilder, type TreeState } from "@/execution";
import type { CallContext, DeterministicOperation, Operation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ── fixtures ────────────────────────────────────────────────────────────────

const opSel = pickSelector("test-us002-plan-parallel-reviews", "execution");
type OpConfig = ReturnType<(typeof opSel)["select"]>;

/** A synthetic tree state so `recordGreenCheckpoint` never runs git. */
const TREE: TreeState = { headSha: "us002-head", dirtyDigest: "us002-dirty" };

const PASS = { success: true };

function makeDeterministicOp(name: string): DeterministicOperation<unknown, unknown, OpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: opSel,
    execute: async () => ({ ...PASS, estimatedCostUsd: 0, durationMs: 0 }),
  };
}

function makeImplementerOp(): RunOperation<{ code: string }, { success: boolean }, OpConfig> {
  return {
    kind: "run",
    name: "implementer",
    stage: "run",
    config: opSel,
    session: { role: "implementer", lifetime: "warm" },
    build: (input) => ({
      role: { id: "us002-role", content: "Implement", overridable: false },
      task: { id: "us002-task", content: input.code, overridable: false },
    }),
    parse: () => PASS,
  };
}

function makePlan(ctx: CallContext) {
  const story = makeStory({ id: "US-002" });
  return new StoryOrchestratorBuilder()
    .addImplementer({ op: makeImplementerOp(), input: { code: "" } })
    .addSemanticReview({
      op: makeDeterministicOp("semantic-review"),
      input: { workdir: "/tmp/us002", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
    })
    .addAdversarialReview({
      op: makeDeterministicOp("adversarial-review"),
      input: { workdir: "/tmp/us002", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
    })
    .build(ctx);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

let runtime: NaxRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function makeCtx(config: NaxConfig): CallContext {
  runtime = makeTestRuntime({ config });
  return makeMockCallContext({
    runtime,
    packageDir: "/tmp/us002",
    storyId: "US-002",
    config,
  });
}

function reviewConfig(parallel: boolean, maxConcurrentSessions = 2): NaxConfig {
  return makeNaxConfig({
    review: { adversarial: { parallel, maxConcurrentSessions } },
  });
}

/** Capture `recordGreen` / `captureTreeState` / resume-planning so nothing touches disk. */
function installInertLoopDeps(): { greens: string[] } {
  const greens: string[] = [];
  _storyOrchestratorDeps.captureTreeState = async () => TREE;
  _storyOrchestratorDeps.recordGreen = async (_storyId, phase) => {
    greens.push(phase);
  };
  _storyOrchestratorDeps.loadCheckpoints = async () => new Map();
  _storyOrchestratorDeps.buildResumePlan = async () => ({
    skipPhases: [],
    revalidateGates: [],
    reason: "no-checkpoint",
  });
  return { greens };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<boolean> {
  return waitForCondition(predicate, timeoutMs).then(
    () => true,
    () => false,
  );
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

interface ReviewCallHandle {
  /** Dispatch / resolution events, in the order they happened. */
  events: string[];
  count(op: string): number;
  hasDispatched(op: string): boolean;
  resolve(op: string, output: unknown): void;
  resolveIfPending(op: string, output: unknown): void;
}

const REVIEW_OPS = new Set(["semantic-review", "adversarial-review"]);

/**
 * A `callOp` stub that hands each review dispatch its own deferred promise, so a
 * test decides exactly when that review settles. Non-review ops resolve through
 * the shared helper and never block.
 */
function installDeferredReviewCallOp(): ReviewCallHandle {
  const base = makeCallOp();
  const events: string[] = [];
  const counts: Record<string, number> = {};
  const pending = new Map<string, Deferred<unknown>>();

  _storyOrchestratorDeps.callOp = async <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I): Promise<O> => {
    counts[op.name] = (counts[op.name] ?? 0) + 1;
    if (!REVIEW_OPS.has(op.name)) return base(ctx, op, input);
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
    resolve: (op, output) => {
      const deferred = pending.get(op);
      assertDefined(deferred, `a pending ${op} dispatch`);
      deferred.resolve(output);
    },
    resolveIfPending: (op, output) => {
      pending.get(op)?.resolve(output);
    },
  };
}

/**
 * Shared body for the two non-concurrent configurations (AC5, AC6): the
 * sequential loop must not even dispatch `adversarial-review` until the
 * `semantic-review` dispatch has resolved, and the event order must show it.
 */
async function expectSequentialReviewDispatch(handle: ReviewCallHandle, ctx: CallContext): Promise<void> {
  const runPromise = makePlan(ctx).run();

  expect(await waitFor(() => handle.hasDispatched("semantic-review"))).toBe(true);
  // Still gated: nothing about a single-session / parallel-off run may start the
  // sibling review while the first dispatch is in flight.
  expect(handle.count("adversarial-review")).toBe(0);

  handle.resolveIfPending("semantic-review", PASS);
  expect(await waitFor(() => handle.hasDispatched("adversarial-review"))).toBe(true);
  handle.resolveIfPending("adversarial-review", PASS);

  await withTimeout(
    runPromise.then(
      () => undefined,
      () => undefined,
    ),
    5_000,
    "ExecutionPlan.run",
  );

  expect(handle.events).toEqual([
    "dispatch:semantic-review",
    "resolve:semantic-review",
    "dispatch:adversarial-review",
    "resolve:adversarial-review",
  ]);
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("ExecutionPlan.run() with review.adversarial.parallel (US-002)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-002 AC1: dispatches callOp exactly once for semantic-review and once for adversarial-review", async () => {
    installInertLoopDeps();
    const counts: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        counts[op.name] = (counts[op.name] ?? 0) + 1;
      },
    });

    const ctx = makeCtx(reviewConfig(true));
    await withTimeout(makePlan(ctx).run(), 5_000, "ExecutionPlan.run");

    expect(counts["semantic-review"]).toBe(1);
    expect(counts["adversarial-review"]).toBe(1);
  });

  test("US-002 AC2: starts both review dispatches before either dispatch resolves", async () => {
    installInertLoopDeps();
    const handle = installDeferredReviewCallOp();

    const ctx = makeCtx(reviewConfig(true));
    const runPromise = makePlan(ctx).run();

    const bothDispatched = await waitFor(
      () => handle.count("semantic-review") === 1 && handle.count("adversarial-review") === 1,
    );
    // Snapshot before resolving anything: a sequential loop only ever has one
    // dispatch in flight here, so this is what separates the pair from it.
    const inFlight = [...handle.events];

    expect(bothDispatched).toBe(true);
    expect(inFlight.sort()).toEqual(["dispatch:adversarial-review", "dispatch:semantic-review"]);

    handle.resolveIfPending("semantic-review", PASS);
    handle.resolveIfPending("adversarial-review", PASS);
    await withTimeout(
      runPromise.then(
        () => undefined,
        () => undefined,
      ),
      5_000,
      "ExecutionPlan.run",
    );
  });

  test("US-002 AC3: with semantic-review seeded as passing (resume) dispatches adversarial-review once", async () => {
    installInertLoopDeps();
    _storyOrchestratorDeps.buildResumePlan = async () => ({
      skipPhases: ["semantic-review"],
      revalidateGates: [],
      reason: "resume",
    });
    const counts: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        counts[op.name] = (counts[op.name] ?? 0) + 1;
      },
    });

    const ctx = makeCtx(reviewConfig(true));
    await withTimeout(makePlan(ctx).run(), 5_000, "ExecutionPlan.run");

    expect(counts["adversarial-review"]).toBe(1);
  });

  test("US-002 AC4: with semantic-review seeded as passing (resume) never dispatches semantic-review", async () => {
    installInertLoopDeps();
    _storyOrchestratorDeps.buildResumePlan = async () => ({
      skipPhases: ["semantic-review"],
      revalidateGates: [],
      reason: "resume",
    });
    const counts: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        counts[op.name] = (counts[op.name] ?? 0) + 1;
      },
    });

    const ctx = makeCtx(reviewConfig(true));
    await withTimeout(makePlan(ctx).run(), 5_000, "ExecutionPlan.run");

    expect(counts["semantic-review"] ?? 0).toBe(0);
  });

  test("US-002 AC5: with parallel false, dispatches adversarial-review only after the semantic-review dispatch resolved", async () => {
    installInertLoopDeps();
    const handle = installDeferredReviewCallOp();

    await expectSequentialReviewDispatch(handle, makeCtx(reviewConfig(false)));
  });

  test("US-002 AC6: with parallel true and maxConcurrentSessions 1, dispatches adversarial-review only after the semantic-review dispatch resolved", async () => {
    installInertLoopDeps();
    const handle = installDeferredReviewCallOp();

    await expectSequentialReviewDispatch(handle, makeCtx(reviewConfig(true, 1)));
  });
});
