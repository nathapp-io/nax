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
 *    shape the runtime never produces.
 *
 * Returning annotated `FlowStepRecord` values fixes (1) *for a step's own
 * fields*, and `makeFlowCtx` extends that to `state.steps` by annotating rather
 * than asserting the inner state.
 *
 * That only becomes a CI gate because of
 * `test/contracts/flow-step-fixture-shape.contract.ts`: `tsconfig.json`
 * **excludes `test`**, so nothing under `test/unit/` or `test/helpers/` is
 * compiled by `bun run typecheck` and these annotations would otherwise be
 * editor-time only. The contract file lives in the one test directory that IS
 * compiled, and imports this module so tsc follows it. Keep that import alive.
 *
 * Two limits worth knowing: the outer `as FlowNodeContext` in `makeFlowCtx`
 * still suppresses checking of `FlowNodeContext`'s *other* members, so this buys
 * step-shape fidelity rather than whole-context fidelity; and no amount of
 * typing detects a change in acpx's *runtime ordering* — only its shape.
 *
 * `recordedSteps` fixes (2) by making the wrong count unwriteable at the call
 * site that mattered — see its own doc comment.
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
import type { FlowNodeContext, FlowRunState, FlowStepRecord } from "acpx/flows";

/** Fixed so fixtures are deterministic; no reader asserts on step timestamps. */
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

/**
 * acpx mints a fresh attempt id per attempt, so two steps of the same node in
 * one history must not share one. Nothing asserts on the value — only on its
 * uniqueness — so a counter is enough and keeps the field honest for any future
 * reader that de-duplicates by attempt.
 */
let attemptSeq = 0;

/**
 * The node types nax-finish actually declares, so a fixture step is labelled the
 * way the flow labels it.
 *
 * `review_*` and `fix_*` are `acp`, `route_*` are `compute`, `commit_*` and the
 * three shell-running nodes are `action`. An unrecognised id falls back to
 * `acp`; pass `nodeType` explicitly if that is wrong for your node, because a
 * wrong label here is exactly the kind of quiet fixture drift this module
 * exists to prevent.
 */
const ACTION_NODE_IDS = new Set(["load_ctx", "acceptance", "quality_gates"]);

function nodeTypeFor(nodeId: string): FlowStepRecord["nodeType"] {
  if (nodeId.startsWith("route_")) return "compute";
  if (nodeId.startsWith("commit_") || ACTION_NODE_IDS.has(nodeId)) return "action";
  return "acp";
}

/**
 * A `FlowNodeContext` for driving a flow node's `run` / `prompt` directly.
 *
 * `state` is annotated rather than asserted, so a rename of `FlowRunState.steps`
 * upstream fails the build here instead of silently feeding every reader
 * `undefined` (which they all `?? []` into a clean, wrong zero).
 */
export function makeFlowCtx(over: {
  input?: unknown;
  outputs?: Record<string, unknown>;
  steps?: FlowStepRecord[];
}): FlowNodeContext {
  const state: Pick<FlowRunState, "steps"> = { steps: over.steps ?? [] };
  return {
    input: over.input ?? {},
    outputs: over.outputs ?? {},
    results: {},
    state,
    services: {},
  } as FlowNodeContext;
}

/**
 * One finished step, as acpx records it.
 *
 * `nodeType` is derived from the node id and `attemptId` is unique per step;
 * override either when a test asserts on it. Prefer overriding to constructing
 * a literal, so the day acpx adds a required field there is exactly one place
 * to fix.
 */
export function makeFlowStep(nodeId: string, overrides: Partial<FlowStepRecord> = {}): FlowStepRecord {
  return {
    attemptId: `${nodeId}-${++attemptSeq}`,
    nodeId,
    nodeType: nodeTypeFor(nodeId),
    promptText: null,
    outcome: "ok",
    startedAt: FIXED_TIME,
    finishedAt: FIXED_TIME,

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
 * `count` already-finished `review_<phase>` steps, each carrying `output`.
 *
 * The parameter counts **recorded steps, not rounds**, because the two differ
 * depending on which node's context you are building — and conflating them is
 * how #1476's off-by-one survived:
 *
 * - At `route_<phase>`, the review that triggered it is already recorded, so
 *   `count` equals the round number. Round 1 is `count: 1`, and `count: 0` is
 *   not a state that node ever observes.
 * - At `review_<phase>` itself, the executing attempt is *not* yet recorded, so
 *   `count` equals `round - 1`. A first attempt is `count: 0` — which does
 *   occur, and which `repromptCount(ctx, phase) > 0` reads as "no retry
 *   notice". Build it with `makeFlowSteps` when the rest of the history
 *   matters, or pass `0` here.
 */
export function reviewRounds(phase: "spec" | "quality", count: number, output: unknown): FlowStepRecord[] {
  if (count < 0) throw new Error(`reviewRounds: count is a number of recorded steps, got ${count}`);
  return Array.from({ length: count }, () => makeFlowStep(`review_${phase}`, { output }));
}
