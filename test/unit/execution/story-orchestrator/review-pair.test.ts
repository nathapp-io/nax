/**
 * US-001 — review-pair helper (src/execution/story-orchestrator/review-pair.ts).
 *
 * `shouldRunReviewsConcurrently` is the caller's eligibility predicate for the
 * concurrent review pair; `runReviewPair` dispatches the two review phases of
 * one story through the existing `runPhase`, waits for both to settle and never
 * cancels one review because its sibling failed.
 *
 * `runPhase` itself is stubbed through `_reviewPairDeps` — the seam pattern
 * `_storyOrchestratorDeps` established in run-phase.ts — so these tests observe
 * only the pair's own wiring: which phases it dispatches, when, what it does
 * with their settlement, and what it logs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeMockCallContext, waitForCondition, withDepsRestore, withTimeout } from "@test/helpers";
import { pickSelector } from "@/config";
import type { InternalPhase, PhaseKind } from "@/execution/story-orchestrator";
import type { PhaseTracking } from "@/execution/story-orchestrator/execution-plan-phases";
import {
  _reviewPairDeps,
  runReviewPair,
  shouldRunReviewsConcurrently,
} from "@/execution/story-orchestrator/review-pair";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { CallContext, DeterministicOperation } from "@/operations";

// ── fixtures ────────────────────────────────────────────────────────────────

const phaseSel = pickSelector("review-pair-test", "execution");
type PhaseOpConfig = ReturnType<(typeof phaseSel)["select"]>;

/**
 * An InternalPhase whose `kind` and op `name` both carry the review phase's
 * name — the two things a caller's phase list can be matched on.
 */
function makePhase(kind: PhaseKind): InternalPhase {
  const op: DeterministicOperation<unknown, unknown, PhaseOpConfig> = {
    kind: "deterministic",
    name: kind,
    stage: "verify",
    config: phaseSel,
    execute: async () => ({ success: true }),
  };
  return { kind, slot: { op, input: {} } };
}

const SEMANTIC = makePhase("semantic-review");
const ADVERSARIAL = makePhase("adversarial-review");
const PAIR: readonly [InternalPhase, InternalPhase] = [SEMANTIC, ADVERSARIAL];

/** Spend the stub `runPhase` books per review — deliberately different per phase. */
const COST_BY_OP: Record<string, number> = { "semantic-review": 0.25, "adversarial-review": 0.75 };

type RunPhaseArgs = Parameters<typeof _reviewPairDeps.runPhase>;

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function makeDeferred(): Deferred {
  let resolveFn: (value: unknown) => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: (value) => resolveFn(value), reject: (error) => rejectFn(error) };
}

interface ControlledRunPhase {
  runPhase: typeof _reviewPairDeps.runPhase;
  /** Op names dispatched, in dispatch order. */
  ops: string[];
  resolve(op: string, output: unknown): void;
  reject(op: string, error: unknown): void;
}

/**
 * A `runPhase` stub handing every call its own deferred, so a test decides
 * exactly when each review settles. On settlement it writes into the
 * `phaseCosts` / `phaseOutputs` records it was handed — the same two objects
 * the real `runPhase` writes into — so an assertion on `tracking` proves the
 * pair threaded the caller's records through rather than fresh ones.
 */
function makeControlledRunPhase(): ControlledRunPhase {
  const ops: string[] = [];
  const deferreds = new Map<string, Deferred>();

  const runPhaseStub = (...args: RunPhaseArgs): Promise<unknown> => {
    const slot = args[1];
    const phaseCosts = args[2];
    const phaseOutputs = args[3];
    const op = slot.op.name;
    ops.push(op);
    const deferred = makeDeferred();
    deferreds.set(op, deferred);
    return deferred.promise.then((output) => {
      phaseOutputs[op] = output;
      phaseCosts[op] = (phaseCosts[op] ?? 0) + COST_BY_OP[op];
      return output;
    });
  };

  return {
    runPhase: runPhaseStub,
    ops,
    resolve: (op, output) => {
      const deferred = deferreds.get(op);
      assertDefined(deferred, `a pending ${op} dispatch`);
      deferred.resolve(output);
    },
    reject: (op, error) => {
      const deferred = deferreds.get(op);
      assertDefined(deferred, `a pending ${op} dispatch`);
      deferred.reject(error);
    },
  };
}

interface Setup {
  ctx: CallContext;
  tracking: PhaseTracking;
  runPhase: ControlledRunPhase;
}

function setup(): Setup {
  const runPhase = makeControlledRunPhase();
  _reviewPairDeps.runPhase = runPhase.runPhase;
  return {
    ctx: makeMockCallContext({ storyId: "US-001" }),
    tracking: { phaseCosts: {}, phaseOutputs: {} },
    runPhase,
  };
}

/** Wait until both reviews have been dispatched — they never settle on their own. */
async function awaitDispatches(runPhase: ControlledRunPhase): Promise<void> {
  await waitForCondition(() => runPhase.ops.length === 2, 1_000);
}

// ── shouldRunReviewsConcurrently ────────────────────────────────────────────

describe("shouldRunReviewsConcurrently (US-001)", () => {
  test("US-001 AC1: true when parallel is on, the cap is 2 and both review phases are about to run", () => {
    const phases = [makePhase("full-suite-gate"), makePhase("verifier"), SEMANTIC, ADVERSARIAL];

    expect(shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: 2 } }, phases)).toBe(
      true,
    );
  });

  test("US-001 AC1 boundary: a cap above the pair's two sessions still allows concurrency", () => {
    expect(shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: 4 } }, PAIR)).toBe(
      true,
    );
  });

  test.each([undefined, 1, 2, 4] as const)(
    "US-001 AC2: false when parallel is off, whatever the cap is (cap %p)",
    (cap) => {
      expect(shouldRunReviewsConcurrently({ adversarial: { parallel: false, maxConcurrentSessions: cap } }, PAIR)).toBe(
        false,
      );
    },
  );

  test("US-001 AC3: false when parallel is on but the cap leaves room for only one session", () => {
    expect(shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: 1 } }, PAIR)).toBe(
      false,
    );
  });

  test("US-001 AC4: false when the review config is undefined", () => {
    expect(shouldRunReviewsConcurrently(undefined, PAIR)).toBe(false);
  });

  test.each([{}, { adversarial: undefined }])(
    "US-001 AC5: false when reviewConfig.adversarial is absent (%p)",
    (reviewConfig) => {
      expect(shouldRunReviewsConcurrently(reviewConfig, PAIR)).toBe(false);
    },
  );

  test("US-001 AC6: true when the cap is omitted — it resolves to the schema default of 2", () => {
    expect(shouldRunReviewsConcurrently({ adversarial: { parallel: true } }, PAIR)).toBe(true);
  });

  test("US-001 AC6 boundary: an explicitly undefined cap resolves exactly like an omitted one", () => {
    expect(
      shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: undefined } }, PAIR),
    ).toBe(true);
  });

  test("US-001 AC7: false when the caller runs semantic-review without adversarial-review", () => {
    expect(
      shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: 2 } }, [
        makePhase("lint-check"),
        SEMANTIC,
      ]),
    ).toBe(false);
  });

  test("US-001 AC8: false when the caller runs adversarial-review without semantic-review", () => {
    expect(
      shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: 2 } }, [
        makePhase("typecheck-check"),
        ADVERSARIAL,
      ]),
    ).toBe(false);
  });

  test("US-001 AC7/AC8 boundary: false when the caller is about to run no phases at all", () => {
    expect(shouldRunReviewsConcurrently({ adversarial: { parallel: true, maxConcurrentSessions: 2 } }, [])).toBe(false);
  });
});

// ── runReviewPair ───────────────────────────────────────────────────────────

describe("runReviewPair (US-001)", () => {
  withDepsRestore(_reviewPairDeps);

  test("US-001 AC9: dispatches both reviews before either dispatch's promise resolves", async () => {
    const { ctx, tracking, runPhase } = setup();

    const pending = runReviewPair(ctx, PAIR, tracking);
    // Neither review is resolved at this point, so both must already be in flight.
    await awaitDispatches(runPhase);
    expect(runPhase.ops).toEqual(["semantic-review", "adversarial-review"]);

    runPhase.resolve("semantic-review", { passed: true });
    runPhase.resolve("adversarial-review", { passed: true });
    await pending;
  });

  test("US-001 AC10: after it resolves, tracking.phaseOutputs holds each review's own output", async () => {
    const { ctx, tracking, runPhase } = setup();

    const pending = runReviewPair(ctx, PAIR, tracking);
    await awaitDispatches(runPhase);
    runPhase.resolve("semantic-review", { passed: true, findings: ["semantic"] });
    runPhase.resolve("adversarial-review", { passed: false, findings: ["adversarial"] });
    await pending;

    expect(tracking.phaseOutputs["semantic-review"]).toEqual({ passed: true, findings: ["semantic"] });
    expect(tracking.phaseOutputs["adversarial-review"]).toEqual({ passed: false, findings: ["adversarial"] });
  });

  test("US-001 AC11: after it resolves, tracking.phaseCosts holds each review's own cost", async () => {
    const { ctx, tracking, runPhase } = setup();

    const pending = runReviewPair(ctx, PAIR, tracking);
    await awaitDispatches(runPhase);
    runPhase.resolve("semantic-review", { passed: true });
    runPhase.resolve("adversarial-review", { passed: true });
    await pending;

    expect(tracking.phaseCosts).toEqual({ "semantic-review": 0.25, "adversarial-review": 0.75 });
  });

  test("US-001 AC12: does not settle while the sibling review is still in flight", async () => {
    const { ctx, tracking, runPhase } = setup();
    const semanticError = new Error("semantic-review exploded");

    const pending = runReviewPair(ctx, PAIR, tracking);
    await awaitDispatches(runPhase);
    runPhase.reject("semantic-review", semanticError);

    // adversarial-review is still unresolved, so nothing may settle yet: an
    // implementation that stops waiting as soon as one review rejects settles
    // here, and the race below returns instead of timing out.
    const settled = pending.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    const outcome = await withTimeout(settled, 100, "runReviewPair").then(
      (value) => value,
      () => "still-pending" as const,
    );
    expect(outcome).toBe("still-pending");

    runPhase.resolve("adversarial-review", { passed: true });
    const rejection = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBe(semanticError);
  });

  test("US-001 AC13: rejects with the semantic-review error when only semantic-review throws", async () => {
    const { ctx, tracking, runPhase } = setup();
    const semanticError = new Error("semantic-review exploded");

    const pending = runReviewPair(ctx, PAIR, tracking);
    await awaitDispatches(runPhase);
    runPhase.reject("semantic-review", semanticError);
    runPhase.resolve("adversarial-review", { passed: true });

    const rejection = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBe(semanticError);
  });

  test("US-001 AC14: rejects with the semantic-review error when both reviews throw", async () => {
    const { ctx, tracking, runPhase } = setup();
    const semanticError = new Error("semantic-review exploded");
    const adversarialError = new Error("adversarial-review exploded");

    const pending = runReviewPair(ctx, PAIR, tracking);
    await awaitDispatches(runPhase);
    runPhase.reject("semantic-review", semanticError);
    runPhase.reject("adversarial-review", adversarialError);

    const rejection = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBe(semanticError);
  });

  describe("logging", () => {
    let entries: LogEntry[];
    let unsubscribe: () => void;

    beforeEach(() => {
      resetLogger();
      initLogger({ level: "silent", suppressConsole: true });
      entries = [];
      unsubscribe = addSink((entry) => entries.push(entry));
    });

    afterEach(() => {
      unsubscribe();
      resetLogger();
    });

    function threwErrors(): LogEntry[] {
      return entries.filter((entry) => entry.level === "error" && entry.message === "Phase threw unexpected error");
    }

    function concurrentDispatchInfos(): LogEntry[] {
      return entries.filter(
        (entry) =>
          entry.level === "info" &&
          entry.message === "Running semantic-review and adversarial-review concurrently" &&
          entry.stage === "story-orchestrator",
      );
    }

    test("US-001 AC15: one error naming the throwing phase, with storyId first, when one review throws", async () => {
      const { ctx, tracking, runPhase } = setup();

      const pending = runReviewPair(ctx, PAIR, tracking);
      await awaitDispatches(runPhase);
      runPhase.reject("semantic-review", new Error("semantic-review exploded"));
      runPhase.resolve("adversarial-review", { passed: true });
      await pending.then(
        () => undefined,
        () => undefined,
      );

      const errors = threwErrors();
      expect(errors.length).toBe(1);
      expect(errors.map((entry) => entry.data?.phase)).toEqual(["semantic-review"]);
      expect(Object.keys(errors[0]?.data ?? {})[0]).toBe("storyId");
      expect(errors[0]?.data?.storyId).toBe("US-001");
    });

    test("US-001 AC15 boundary: one error per throwing phase when both reviews throw", async () => {
      const { ctx, tracking, runPhase } = setup();

      const pending = runReviewPair(ctx, PAIR, tracking);
      await awaitDispatches(runPhase);
      runPhase.reject("semantic-review", new Error("semantic-review exploded"));
      runPhase.reject("adversarial-review", new Error("adversarial-review exploded"));
      await pending.then(
        () => undefined,
        () => undefined,
      );

      const errors = threwErrors();
      expect(errors.length).toBe(2);
      const phasesLogged = errors.map((entry) => entry.data?.phase);
      expect(phasesLogged).toContain("semantic-review");
      expect(phasesLogged).toContain("adversarial-review");
      for (const entry of errors) {
        expect(Object.keys(entry.data ?? {})[0]).toBe("storyId");
      }
    });

    test("US-001 AC16: logs one info line about the concurrent dispatch under story-orchestrator", async () => {
      const { ctx, tracking, runPhase } = setup();

      const pending = runReviewPair(ctx, PAIR, tracking);
      await awaitDispatches(runPhase);
      runPhase.resolve("semantic-review", { passed: true });
      runPhase.resolve("adversarial-review", { passed: true });
      await pending;

      const info = concurrentDispatchInfos();
      expect(info.length).toBe(1);
      expect(Object.keys(info[0]?.data ?? {})[0]).toBe("storyId");
      expect(info[0]?.data?.storyId).toBe("US-001");
    });

    test("US-001 AC16 boundary: the concurrent-dispatch line is logged once even when a review throws", async () => {
      const { ctx, tracking, runPhase } = setup();

      const pending = runReviewPair(ctx, PAIR, tracking);
      await awaitDispatches(runPhase);
      runPhase.reject("semantic-review", new Error("semantic-review exploded"));
      runPhase.resolve("adversarial-review", { passed: true });
      await pending.then(
        () => undefined,
        () => undefined,
      );

      expect(concurrentDispatchInfos().length).toBe(1);
    });
  });
});
