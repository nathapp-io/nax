import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { ParseValidationError } from "@/agents/retry";
import { workflowConfigSelector } from "@/config";
import {
  type BotPrReviewInput,
  botPrReviewOp,
  botPrStaticReviewOp,
  type PrEarlierVerdict,
  parsePrReviewReply,
} from "@/operations";
import { REVIEWER_VERIFY_TOOLS } from "@/operations/workflow-story-review";
import {
  buildBotTriageRetry,
  buildWorkflowBranchCoverageRetry,
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  reviewerCommandsSection,
} from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const runtimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});
function ctx() {
  const runtime = makeTestRuntime({ config: makeNaxConfig({ workflow: { models: { branchReview: "powerful" } } }) });
  runtimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}
const input: BotPrReviewInput = { prompt: "review PR", timeoutMs: 1000, threadIds: ["T1", "T2"], commentIds: [] };
const reply = (ids: string[], issue = "bug") =>
  JSON.stringify({
    intent: "pass",
    quality: "changes",
    findings: [{ issue }],
    threads: ids.map((id) => ({ id, decision: "agree", reason: "needed" })),
  });
const retryCtx = (lastOutput: string) => ({
  site: "run" as const,
  agentName: "native",
  stage: "review" as const,
  lastOutput,
});

for (const op of [botPrReviewOp, botPrStaticReviewOp]) {
  describe(op.name, () => {
    test("US-006 AC-10 parse forwards earlier and decision allowlists", () => {
      const value = { ...input, earlierIds: ["E1"], decisionIds: ["D-1"] };
      const earlier = [{ id: "E1", status: "fixed", reason: "done" }] satisfies PrEarlierVerdict[];
      const output = JSON.stringify({
        intent: "pass",
        quality: "changes",
        earlier,
        findings: [{ issue: "bug", decision: "D-1" }],
      });
      expect(op.parse(output, value, ctx())?.earlier).toEqual(earlier);
      expect(op.parse(output, value, ctx())?.findings[0]).toHaveProperty("decision", "D-1");
    });
    test("US-006 AC-11 retries missing earlier ids separately and retains partial verdict on exhaustion", () => {
      if (typeof op.retry !== "function") throw new Error("expected retry resolver");
      const value = { ...input, earlierIds: ["E1"], decisionIds: ["D-1"] };
      const strategy = op.retry(value, ctx());
      if (!strategy || !("shouldRetry" in strategy)) throw new Error("expected retry strategy");
      const failure = new ParseValidationError("incomplete");
      const partial = reply(["T1", "T2"]);
      expect(strategy.shouldRetry(failure, 0, retryCtx(partial))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: buildBotTriageRetry([], ["E1"]),
      });
      const complete = JSON.stringify({
        ...JSON.parse(partial),
        earlier: [{ id: "E1", status: "fixed", reason: "done" }],
        findings: [{ issue: "bug", decision: "D-1" }],
      });
      expect(strategy.shouldRetry(failure, 0, retryCtx(complete))).toEqual({ retry: false });
      const incomplete = JSON.stringify({ ...JSON.parse(complete), threads: [] });
      expect(strategy.shouldRetry(failure, 1, retryCtx(incomplete))).toMatchObject({
        retry: false,
        fallback: {
          earlier: [{ id: "E1", status: "fixed", reason: "done" }],
          findings: [{ issue: "bug", decision: "D-1" }],
        },
      });
      expect(strategy.shouldRetry(failure, 1, retryCtx(partial))).toEqual({
        retry: false,
        fallback: op.parse(partial, value, ctx()),
      });
    });
    test("US-015 AC-1–5 coverage retries follow triage, remain optional and retain exhausted findings", () => {
      if (typeof op.retry !== "function") throw new Error("expected retry resolver");
      const value = {
        ...input,
        commentIds: ["C1"],
        earlierIds: ["E1"],
        requiredFiles: ["src/a.ts"],
        repoRoot: "/checkout",
        range: "reviewed..HEAD",
      };
      const partial = JSON.stringify({
        ...JSON.parse(reply(["T1", "T2"])),
        comments: [{ id: "C1", decision: "agree", reason: "yes" }],
        earlier: [{ id: "E1", status: "open", reason: "still" }],
      });
      const strategy = op.retry(value, ctx());
      if (!strategy || !("shouldRetry" in strategy)) throw new Error("expected strategy");
      const failure = new ParseValidationError("incomplete");
      expect(strategy.shouldRetry(failure, 0, retryCtx(partial))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: buildWorkflowBranchCoverageRetry(value.range, ["src/a.ts"]),
      });
      const covered = JSON.stringify({ ...JSON.parse(partial), inspectedFiles: ["/checkout/src/a.ts"] });
      expect(strategy.shouldRetry(failure, 0, retryCtx(covered))).toEqual({ retry: false });
      for (const [field, expected] of [
        ["threads", buildBotTriageRetry(["T1", "T2"], [])],
        ["comments", buildBotTriageRetry(["C1"], [])],
        ["earlier", buildBotTriageRetry([], ["E1"])],
      ] as const) {
        expect(
          strategy.shouldRetry(failure, 0, retryCtx(JSON.stringify({ ...JSON.parse(partial), [field]: [] }))),
        ).toEqual({ retry: true, delayMs: 0, nextPrompt: expected });
      }
      expect(strategy.shouldRetry(failure, 1, retryCtx(partial))).toEqual({
        retry: false,
        fallback: op.parse(partial, value, ctx()),
      });
      expect(op.parse(partial, value, ctx())?.findings[0]?.issue).toBe("bug");
      const optional = op.retry({ ...input, commentIds: ["C1"], earlierIds: ["E1"] }, ctx());
      if (!optional || !("shouldRetry" in optional)) throw new Error("expected strategy");
      expect(optional.shouldRetry(failure, 0, retryCtx(partial))).toEqual({ retry: false });
    });
    test("AC-13/14/15 declares bounded tools, config and fresh reviewer role", () => {
      expect(op.tools).toEqual(op === botPrReviewOp ? [...REVIEWER_VERIFY_TOOLS] : ["Read", "Glob", "Grep"]);
      expect(op.session).toEqual({ role: "wf-branch-review", lifetime: "fresh" });
      expect(op.config).toBe(workflowConfigSelector);
      expect(op.stage).toBe("review");
    });
    test("AC-16/17 only trusted review includes command instructions", () => {
      const built = op.build(input, ctx());
      expect(built.task.content).toBe(input.prompt);
      if (op === botPrReviewOp) expect(built.instructions).toEqual(reviewerCommandsSection());
      else expect(built).not.toHaveProperty("instructions");
    });
    test("AC-18/19 model comes only from input", () => {
      if (typeof op.model !== "function") throw new Error("expected model resolver");
      expect(op.model({ ...input, model: "fast" }, ctx())).toBe("fast");
      expect(op.model(input, ctx())).toBeUndefined();
    });
    test("AC-20/21/22 real strategy retries partial or malformed replies and keeps the second partial", () => {
      if (typeof op.retry !== "function") throw new Error("expected retry resolver");
      const strategy = op.retry(input, ctx());
      if (!strategy || !("shouldRetry" in strategy)) throw new Error("expected retry strategy");
      const failure = new ParseValidationError("incomplete");
      expect(strategy.shouldRetry(failure, 0, retryCtx(reply(["T2"])))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: buildBotTriageRetry(["T1"]),
      });
      expect(strategy.shouldRetry(failure, 0, retryCtx("not JSON"))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: buildWorkflowReviewJsonRetry(),
      });
      const second = reply(["T2"], "second finding");
      expect(strategy.shouldRetry(failure, 1, retryCtx(second))).toEqual({
        retry: false,
        fallback: parsePrReviewReply(second, input.threadIds, []),
      });
      expect(op.parse(second, input, ctx())?.findings[0]?.issue).toBe("second finding");
      expect(strategy.shouldRetry(failure, 0, retryCtx(reply(["T1", "T2"])))).toEqual({ retry: false });
      expect(strategy.shouldRetry(failure, 1, retryCtx("not JSON"))).toEqual({ retry: false, fallback: null });
      expect(strategy.shouldRetry(failure, 0, retryCtx('{"intent": "pass",'))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: buildWorkflowReviewJsonRetryCondensed(),
      });
    });
  });
}
