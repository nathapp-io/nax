/**
 * Fixtures for acpx's `FlowRunState.steps` — the ordered history a flow node
 * reads through `ctx.state.steps`.
 *
 * ## Why this exists
 *
 * The nax-finish flow tests used to hand-build steps as `{ nodeId, output }`
 * literals cast `as never`. Two things were wrong with that, and the second one
 * shipped a bug:
 *
 * 1. The cast meant no test would break if acpx renamed or moved a field. The
 *    fixtures were a two-property subset of a twelve-property record, and
 *    nothing said so.
 * 2. The *ordering* convention lived only in prose comments. PR #1476 shipped
 *    `attempts < MAX_REPROMPT_ATTEMPTS` where the self-inclusive count needs
 *    `<=`, which made its own retry edge dead code. It survived four clean
 *    reviews and 1130 green tests because the tests hand-built a `state.steps`
 *    shape the runtime never produces — round 1 with zero steps recorded.
 *
 * Building fixtures as real `FlowStepRecord` values fixes (1): `tsc` now breaks
 * when acpx's shape changes. `reviewRounds` fixes (2) by making the wrong shape
 * unwriteable — see its own doc comment.
 *
 * ## The rule
 *
 * One sentence explains every reader in `flows/nax-finish/flow-ctx.ts` and
 * `flows/nax-finish/verdict.ts`:
 *
 * > `ctx.state.steps` holds every step that has **finished**, in completion
 * > order. The node currently executing is not in it. The node that just
 * > finished **is**.
 *
 * acpx pushes the finished step onto the live state (`recordFlowStepOutcome`)
 * before it resolves the next node, so a node reading this array always sees
 * its own trigger already recorded. That is why `repromptCount`, read from
 * `route_<phase>`, already counts the current round — and why
 * `incrementalSince`, read from the `review_<phase>` node itself rather than
 * from the node after it, still finds the *previous* round rather than itself.
 *
 * Both behaviours follow from the one rule. Describing the array relative to
 * each caller ("never includes itself" / "already includes this round") is what
 * made them look like contradictory special cases.
 */
import type { FlowNodeContext, FlowStepRecord } from "acpx/flows";

/** Fixed so fixtures are deterministic; no reader asserts on step timestamps. */
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

/**
 * A `FlowNodeContext` for driving a flow node's `run` / `prompt` directly.
 *
 * Several nax-finish test files grew their own copy of this; new files should
 * use this one rather than adding a fourth.
 */
export function makeFlowCtx(over: {
  input?: unknown;
  outputs?: Record<string, unknown>;
  steps?: FlowStepRecord[];
}): FlowNodeContext {
  return {
    input: over.input ?? {},
    outputs: over.outputs ?? {},
    results: {},
    state: { steps: over.steps ?? [] },
    services: {},
  } as FlowNodeContext;
}

/**
 * One finished step, as acpx records it.
 *
 * Defaults describe the common case in these tests: an `acp` node that
 * completed and produced `output`. Override anything a specific test asserts
 * on — but prefer overriding to constructing a literal, so the day acpx adds a
 * required field there is exactly one place to fix.
 */
export function makeFlowStep(nodeId: string, overrides: Partial<FlowStepRecord> = {}): FlowStepRecord {
  return {
    attemptId: `${nodeId}-attempt`,
    nodeId,
    nodeType: "acp",
    outcome: "ok",
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,
    promptText: null,
    rawText: null,
    output: undefined,
    session: null,
    agent: null,
    ...overrides,
  };
}

/**
 * Finished history, oldest first.
 *
 * Each entry is either a bare node id, or `[nodeId, output]` when a reader
 * looks at what that step produced — `incrementalSince`, for instance, reads
 * `shaBefore` off the first `commit_*` step after a review.
 */
export function makeFlowSteps(entries: readonly (string | readonly [string, unknown])[]): FlowStepRecord[] {
  return entries.map((entry) =>
    typeof entry === "string" ? makeFlowStep(entry) : makeFlowStep(entry[0], { output: entry[1] }),
  );
}

/**
 * `state.steps` as `route_<phase>` sees it on review round `round`.
 *
 * `round` is **1-based and self-inclusive**: round 1 yields exactly one
 * `review_<phase>` step, because by the time `route_<phase>` runs, the review
 * that triggered it has already been recorded. There is deliberately no way to
 * express "round 1 with nothing recorded yet" — that state does not occur in a
 * real run, and encoding it in a fixture is precisely the mistake that let
 * #1476's off-by-one through.
 *
 * @param phase  Which review phase's history to build.
 * @param round  1-based round number; also the number of steps returned.
 * @param output The verdict each of those rounds produced.
 */
export function reviewRounds(phase: "spec" | "quality", round: number, output: unknown): FlowStepRecord[] {
  if (round < 1) throw new Error(`reviewRounds: round is 1-based and self-inclusive, got ${round}`);
  return Array.from({ length: round }, () => makeFlowStep(`review_${phase}`, { output }));
}
