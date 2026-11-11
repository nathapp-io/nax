import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
  opSelector,
} from "@test/helpers";
import { ParseValidationError } from "@/agents";
import type { RetryStrategy } from "@/agents/retry";
import type { TurnResult } from "@/agents/types";
import { workflowConfigSelector } from "@/config";
import { callOp, parseBranchReviewReply, type WorkflowBranchReviewInput, workflowBranchReviewOp } from "@/operations";
import { buildWorkflowBranchCoverageRetry, buildWorkflowReviewJsonRetry } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function buildCtx() {
  const runtime = makeTestRuntime({ config: makeNaxConfig() });
  createdRuntimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchReviewInput = {
  prompt: "review the branch",
  timeoutMs: 1000,
  minorIds: [],
  repoRoot: "/repo",
  requiredFiles: ["src/a.ts"],
  range: "seed0..HEAD",
};

/** The op's `retry` resolver, resolved into the strategy callOp would run. */
function strategyFor(i: WorkflowBranchReviewInput): RetryStrategy {
  const resolve = workflowBranchReviewOp.retry;
  if (typeof resolve !== "function") throw new Error("retry must be a resolver");
  const strategy = resolve(i, buildCtx());
  if (strategy === undefined || !("shouldRetry" in strategy)) throw new Error("retry must resolve to a strategy");
  return strategy;
}

function retryCtx(lastOutput: string) {
  return { site: "run" as const, agentName: "claude", stage: "review" as const, storyId: "_run", lastOutput };
}

/** A branch-review reply as the reviewer sends it: parseable, with the files it claims to have read. */
function verdictJson(inspectedFiles: readonly string[], findings: readonly unknown[] = []): string {
  return JSON.stringify({
    spec: "pass",
    quality: "approved",
    inspectedFiles,
    findings,
    cannotVerify: [],
    minorTriage: [],
  });
}

const probe = new ParseValidationError("parse probe");
const IMPORTANT_FINDING = {
  kind: "quality",
  severity: "important",
  issue: "src/b.ts is never exported from the barrel",
  file: "src/b.ts",
};

describe("workflowBranchReviewOp coverage retry budget (US-002)", () => {
  test("AC-6: a reply that reads none of the required files is asked again at attempt 1 of 3", () => {
    const decision = strategyFor(input).shouldRetry(probe, 0, retryCtx(verdictJson([])));

    expect(decision).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(input.range, ["src/a.ts"], false, { attempt: 1, max: 3 }),
    });
  });

  test("AC-7: a coverage retry that covered no more files stops with the parsed verdict as its fallback", () => {
    const strategy = strategyFor(input);
    const first = verdictJson([], [IMPORTANT_FINDING]);
    const second = verdictJson([], [IMPORTANT_FINDING]);

    expect(strategy.shouldRetry(probe, 0, retryCtx(first))).toMatchObject({ retry: true });
    const decision = strategy.shouldRetry(probe, 1, retryCtx(second));

    expect(decision).toEqual({ retry: false, fallback: parseBranchReviewReply(second, input.minorIds) });
    const fallback = "fallback" in decision ? decision.fallback : undefined;
    expect(fallback).toMatchObject({
      spec: "pass",
      inspectedFiles: [],
      findings: [{ issue: IMPORTANT_FINDING.issue }],
    });
  });

  test("AC-8: coverageRetries: 1 makes the one coverage retry attempt 1 of 1", () => {
    const decision = strategyFor({ ...input, coverageRetries: 1 }).shouldRetry(probe, 0, retryCtx(verdictJson([])));

    expect(decision).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(input.range, ["src/a.ts"], false, { attempt: 1, max: 1 }),
    });
  });

  test("AC-9: an unparseable reply at attempt 0 keeps the plain JSON retry prompt", () => {
    const decision = strategyFor(input).shouldRetry(probe, 0, retryCtx("not json at all"));

    expect(decision).toEqual({ retry: true, delayMs: 0, nextPrompt: buildWorkflowReviewJsonRetry() });
  });

  test("AC-10: an unparseable reply with the shape retry spent and no coverage retry sent falls back to null", () => {
    const decision = strategyFor(input).shouldRetry(probe, 1, retryCtx("not json at all"));

    expect(decision).toEqual({ retry: false, fallback: null });
  });

  test("AC-11: an empty required set is complete, so the reply is not retried", () => {
    const decision = strategyFor({ ...input, requiredFiles: [] }).shouldRetry(probe, 0, retryCtx(verdictJson([])));

    expect(decision).toEqual({ retry: false });
  });

  test("AC-16: coverageRetries: 0 keeps the incomplete verdict and its findings, with no coverage prompt", () => {
    const lastOutput = verdictJson([], [IMPORTANT_FINDING]);
    const decision = strategyFor({ ...input, coverageRetries: 0 }).shouldRetry(probe, 0, retryCtx(lastOutput));

    expect(decision).toEqual({ retry: false, fallback: parseBranchReviewReply(lastOutput, input.minorIds) });
    const fallback = "fallback" in decision ? decision.fallback : undefined;
    expect(fallback).toMatchObject({
      spec: "pass",
      inspectedFiles: [],
      findings: [{ issue: IMPORTANT_FINDING.issue }],
    });
  });
});

describe("workflowBranchReviewOp coverage retries through callOp (AC-15)", () => {
  test("AC-15: two coverage retries — the second named 2 of 3 — and the third reply is the verdict", async () => {
    const prompts: string[] = [];
    const handles: { id: string }[] = [];
    const replies = [verdictJson([]), verdictJson(["src/a.ts"]), verdictJson(["src/a.ts", "src/b.ts"])];
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, handle, prompt): Promise<TurnResult> => {
        prompts.push(prompt);
        handles.push(handle);
        return {
          output: replies[prompts.length - 1] ?? "",
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const verdict = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "_run" },
      workflowBranchReviewOp,
      {
        prompt: "review the branch",
        timeoutMs: 1000,
        minorIds: [],
        requiredFiles: ["src/a.ts", "src/b.ts"],
        repoRoot: "/repo",
        range: "seed0..HEAD",
      },
    );

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("This is coverage retry 1 of 3.");
    expect(prompts[2]).toContain("This is coverage retry 2 of 3.");
    // Both coverage retries run in the review's one session, so the reviewer keeps what it read.
    expect(handles[1]).toBe(handles[0]);
    expect(handles[2]).toBe(handles[0]);
    expect(verdict?.inspectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
