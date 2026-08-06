import { describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import type { FlowNodeContext } from "acpx/flows";
import { makeFlowCtx, reviewRounds } from "@test/helpers";

/**
 * The reprompt path: what happens when a reviewer replies with prose instead of
 * the JSON verdict contract.
 *
 * Split out of `flow-graph.test.ts` (800-line test cap). Kept whole rather than
 * scattered because the round-1/round-2 pairs only make sense read together —
 * see `test/helpers/flow-steps.ts` for the step-ordering rule they encode.
 */

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };
const ctxOf = (over: { outputs?: Record<string, unknown>; steps?: FlowNodeContext["state"]["steps"] }) =>
  makeFlowCtx({ input: INPUT, ...over });

type NodeRun<T> = { run: (ctx: FlowNodeContext) => Promise<T> | T };
const nodeRun = <T>(id: string) => flow.nodes[id] as unknown as NodeRun<T>;
const switchOf = (from: string) => {
  const edge = flow.edges.find((e) => e.from === from && "switch" in e);
  if (!edge || !("switch" in edge)) throw new Error(`no switch edge from ${from}`);
  return edge.switch;
};

const REPROMPT_VERDICT = { route: "reprompt", findings: [] };

describe("reprompt edges", () => {
  test("route_spec routes reprompt back to review_spec", () => {
    expect(switchOf("route_spec").cases.reprompt).toBe("review_spec");
  });

  test("route_quality routes reprompt back to review_quality", () => {
    expect(switchOf("route_quality").cases.reprompt).toBe("review_quality");
  });

  test("the existing routes are untouched", () => {
    expect(switchOf("route_quality").cases.clean).toBe("quality_gates");
    expect(switchOf("route_quality").cases.fix).toBe("fix_quality");
    expect(switchOf("route_quality").cases.escalate).toBe("escalate");
  });

  // `reviewRounds(phase, N, …)` builds N *already-finished* review steps. At a
  // `route_<phase>` node that equals the round number, because the review that
  // triggered the route is recorded before the route runs; at a `review_<phase>`
  // node it is one less, since the executing attempt is not yet recorded. See
  // test/helpers/flow-steps.ts.
  //
  // Both round-1 route cases below FAIL under the old (buggy) `<` comparison,
  // which escalated on the very first unparseable reply instead of retrying.
  test("route_quality yields reprompt on the first unparseable verdict (round 1)", async () => {
    const verdict = { route: "reprompt", findings: [], raw: "prose" };
    const out = await nodeRun<{ route: string }>("route_quality").run(
      ctxOf({
        outputs: { review_quality: verdict },
        steps: reviewRounds("quality", 1, verdict),
      }),
    );
    expect(out.route).toBe("reprompt");
  });

  test("route_quality escalates on the second consecutive unparseable verdict (round 2)", async () => {
    const verdict = { route: "reprompt", findings: [], raw: "prose" };
    const out = await nodeRun<{ route: string; escalationReason?: string }>("route_quality").run(
      ctxOf({
        outputs: { review_quality: verdict },
        steps: reviewRounds("quality", 2, verdict),
      }),
    );
    expect(out.route).toBe("escalate");
    expect(out.escalationReason).toContain("after 2 attempts");
  });

  // The complement of the retry-notice tests, and the case the old `round`
  // naming made look unrepresentable: a review node on its FIRST attempt has
  // zero recorded steps of its own, so `repromptCount(ctx, phase) > 0` is
  // false and the prompt must not open with a retry apology.
  test.each(["spec", "quality"] as const)(
    "review_%s on its first attempt carries no retry notice",
    (phase) => {
      const node = flow.nodes[`review_${phase}`] as unknown as { prompt: (c: FlowNodeContext) => string };
      const prompt = node.prompt(
        ctxOf({
          outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
          steps: reviewRounds(phase, 0, REPROMPT_VERDICT),
        }),
      );
      expect(prompt).not.toContain("previous reply could not be parsed");
    },
  );

  test("review_quality leads with the retry notice after a reprompt", () => {
    const node = flow.nodes.review_quality as unknown as { prompt: (c: FlowNodeContext) => string };
    const prompt = node.prompt(
      ctxOf({
        outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
        steps: reviewRounds("quality", 1, REPROMPT_VERDICT),
      }),
    );
    expect(prompt).toContain("previous reply could not be parsed");
  });

  test("a retried review is a FULL review, not an incremental one", () => {
    // incrementalSince scopes a re-review to firstCommit.shaBefore..HEAD by finding
    // the first commit_* step after the last review_<phase>. On a reprompt re-entry
    // no commit_* follows, so it returns null and the whole base...HEAD diff is
    // re-read. That is right — the previous attempt produced no verdict, so there is
    // no cleared window to skip. Pinned so nobody "optimises" it into an incremental.
    const node = flow.nodes.review_quality as unknown as { prompt: (c: FlowNodeContext) => string };
    const prompt = node.prompt(
      ctxOf({
        outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
        steps: reviewRounds("quality", 1, REPROMPT_VERDICT),
      }),
    );
    expect(prompt).toContain("git diff origin/main...HEAD");
    expect(prompt).not.toContain("continuing a review you already started");
  });

  // The `spec` phase had only the two static edge assertions above, while
  // `quality` was walked live. That asymmetry is a real coverage hole, not a
  // stylistic one: `repromptCount` and `routeReview` are phase-parameterised,
  // so a hardcoded "quality" anywhere in that path — or a `review_spec` prompt
  // that forgets to pass `retry` — is invisible to the quality-only walk. These
  // mirror the four quality cases against the spec phase.
  test("route_spec yields reprompt on the first unparseable verdict (round 1)", async () => {
    const out = await nodeRun<{ route: string }>("route_spec").run(
      ctxOf({
        outputs: { review_spec: REPROMPT_VERDICT },
        steps: reviewRounds("spec", 1, REPROMPT_VERDICT),
      }),
    );
    expect(out.route).toBe("reprompt");
  });

  test("route_spec escalates on the second consecutive unparseable verdict (round 2)", async () => {
    const out = await nodeRun<{ route: string; escalationReason?: string }>("route_spec").run(
      ctxOf({
        outputs: { review_spec: REPROMPT_VERDICT },
        steps: reviewRounds("spec", 2, REPROMPT_VERDICT),
      }),
    );
    expect(out.route).toBe("escalate");
    expect(out.escalationReason).toContain("after 2 attempts");
  });

  test("review_spec leads with the retry notice after a reprompt", () => {
    const node = flow.nodes.review_spec as unknown as { prompt: (c: FlowNodeContext) => string };
    const prompt = node.prompt(
      ctxOf({
        outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
        steps: reviewRounds("spec", 1, REPROMPT_VERDICT),
      }),
    );
    expect(prompt).toContain("previous reply could not be parsed");
  });

  test("a retried spec review is a FULL review, not an incremental one", () => {
    const node = flow.nodes.review_spec as unknown as { prompt: (c: FlowNodeContext) => string };
    const prompt = node.prompt(
      ctxOf({
        outputs: { load_ctx: { base: "origin/main", specPath: "spec.md" } },
        steps: reviewRounds("spec", 1, REPROMPT_VERDICT),
      }),
    );
    expect(prompt).toContain("git diff origin/main...HEAD");
    expect(prompt).not.toContain("continuing a review you already started");
  });

  // The counters are per phase. A spec reprompt must not push the quality
  // phase toward its cap, or a run that stumbled once in each phase would
  // escalate the second one on its first unparseable reply.
  test("a spec reprompt does not count toward the quality phase's cap", async () => {
    const out = await nodeRun<{ route: string }>("route_quality").run(
      ctxOf({
        outputs: { review_quality: REPROMPT_VERDICT },
        steps: [...reviewRounds("spec", 2, REPROMPT_VERDICT), ...reviewRounds("quality", 1, REPROMPT_VERDICT)],
      }),
    );
    expect(out.route).toBe("reprompt");
  });
});
