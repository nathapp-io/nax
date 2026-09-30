/**
 * US-003 — `dispatchRevalidationPhase` (src/execution/story-orchestrator/revalidation-reviews.ts).
 *
 * The revalidation sweep's per-phase dispatch step: it dispatches the phase it
 * was handed and reports the kinds it dispatched. For `semantic-review` in a
 * sweep that is eligible for the concurrent pair it dispatches BOTH reviews and
 * reports both kinds; for every other case it reports only the phase's own kind.
 *
 * The dispatch is observed through `_storyOrchestratorDeps.callOp` — the seam
 * `runPhase` (and therefore `runReviewPair`) actually dispatches through — so
 * these tests pin the observable dispatch set, not the internal helper used.
 */
import { describe, expect, test } from "bun:test";
import { makeCallOp, makeMockCallContext, makeNaxConfig, withDepsRestore } from "@test/helpers";
import { type NaxConfig, pickSelector } from "@/config";
import { _storyOrchestratorDeps } from "@/execution";
import type { InternalPhase, PhaseKind } from "@/execution/story-orchestrator";
import type { PhaseTracking } from "@/execution/story-orchestrator/execution-plan-phases";
import { dispatchRevalidationPhase } from "@/execution/story-orchestrator/revalidation-reviews";
import type { CallContext, DeterministicOperation } from "@/operations";

// ── fixtures ────────────────────────────────────────────────────────────────

const phaseSel = pickSelector("us003-revalidation-phase-sel", "execution");
type PhaseOpConfig = ReturnType<(typeof phaseSel)["select"]>;

/** An InternalPhase whose `kind` and op `name` both carry the phase's name. */
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

const GATE = makePhase("full-suite-gate");
const LINT = makePhase("lint-check");
const SEMANTIC = makePhase("semantic-review");
const ADVERSARIAL = makePhase("adversarial-review");
/** A sweep that selected both reviews — the only shape the pair is eligible in. */
const BOTH_REVIEWS: readonly InternalPhase[] = [GATE, LINT, SEMANTIC, ADVERSARIAL];
/** A sweep that selected `semantic-review` alone (`autofix-test-writer`'s set). */
const SEMANTIC_ONLY: readonly InternalPhase[] = [GATE, LINT, SEMANTIC];

function reviewConfig(parallel: boolean, maxConcurrentSessions = 2): NaxConfig {
  return makeNaxConfig({ review: { adversarial: { parallel, maxConcurrentSessions } } });
}

interface Setup {
  ctx: CallContext;
  tracking: PhaseTracking;
  dispatched: string[];
}

function setup(config: NaxConfig): Setup {
  const dispatched: string[] = [];
  _storyOrchestratorDeps.callOp = makeCallOp({ onDispatch: (op) => dispatched.push(op.name) });
  return {
    ctx: makeMockCallContext({ storyId: "US-003", config }),
    tracking: { phaseCosts: {}, phaseOutputs: {} },
    dispatched,
  };
}

// ── AC14 ────────────────────────────────────────────────────────────────────

describe("dispatchRevalidationPhase (US-003)", () => {
  withDepsRestore(_storyOrchestratorDeps);

  test("US-003 AC14: semantic-review in an eligible sweep returns both review kinds", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(true));

    const kinds = await dispatchRevalidationPhase(ctx, SEMANTIC, BOTH_REVIEWS, tracking);

    expect(kinds).toEqual(["semantic-review", "adversarial-review"]);
    expect(dispatched).toEqual(["semantic-review", "adversarial-review"]);
  });

  test("US-003 AC14 boundary: the pair is dispatched only once, and both outputs land in tracking", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(true));

    await dispatchRevalidationPhase(ctx, SEMANTIC, BOTH_REVIEWS, tracking);

    expect(dispatched.filter((name) => name === "semantic-review")).toHaveLength(1);
    expect(dispatched.filter((name) => name === "adversarial-review")).toHaveLength(1);
    expect(Object.keys(tracking.phaseOutputs).sort()).toEqual(["adversarial-review", "semantic-review"]);
  });

  // ── AC15 ──────────────────────────────────────────────────────────────────

  test("US-003 AC15: with parallel off, semantic-review returns only its own kind", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(false));

    const kinds = await dispatchRevalidationPhase(ctx, SEMANTIC, BOTH_REVIEWS, tracking);

    expect(kinds).toEqual(["semantic-review"]);
    expect(dispatched).toEqual(["semantic-review"]);
  });

  test("US-003 AC15 boundary: with parallel off, adversarial-review returns only its own kind", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(false));

    const kinds = await dispatchRevalidationPhase(ctx, ADVERSARIAL, BOTH_REVIEWS, tracking);

    expect(kinds).toEqual(["adversarial-review"]);
    expect(dispatched).toEqual(["adversarial-review"]);
  });

  test("US-003 AC15 boundary: a non-review phase returns only its own kind even with parallel on", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(true));

    const kinds = await dispatchRevalidationPhase(ctx, LINT, BOTH_REVIEWS, tracking);

    expect(kinds).toEqual(["lint-check"]);
    expect(dispatched).toEqual(["lint-check"]);
  });

  test("US-003 AC15 boundary: parallel on but the sweep lacks adversarial-review — semantic-review stays alone", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(true));

    const kinds = await dispatchRevalidationPhase(ctx, SEMANTIC, SEMANTIC_ONLY, tracking);

    expect(kinds).toEqual(["semantic-review"]);
    expect(dispatched).toEqual(["semantic-review"]);
  });

  test("US-003 AC15 boundary: parallel on but the session cap is 1 — semantic-review stays alone", async () => {
    const { ctx, tracking, dispatched } = setup(reviewConfig(true, 1));

    const kinds = await dispatchRevalidationPhase(ctx, SEMANTIC, BOTH_REVIEWS, tracking);

    expect(kinds).toEqual(["semantic-review"]);
    expect(dispatched).toEqual(["semantic-review"]);
  });
});
