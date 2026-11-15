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
import {
  buildWorkflowBranchCoverageRetry,
  buildWorkflowBranchVerdictMismatchRetry,
  buildWorkflowReviewJsonRetry,
} from "@/prompts";
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
  test("AC-11: retry names the diff part holding the unread file", async () => {
    const prompts: string[] = [];
    const handles: { id: string }[] = [];
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, handle, prompt): Promise<TurnResult> => {
        prompts.push(prompt);
        handles.push(handle);
        return {
          output: verdictJson(prompts.length === 1 ? [] : ["a.ts"]),
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
      { ...input, requiredFiles: ["a.ts"], diffParts: [{ path: "/run/package-branch-part-02.diff", files: ["a.ts"] }] },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("- a.ts (package-branch-part-02.diff)");
    expect(handles[1]).toBe(handles[0]);
    expect(verdict?.inspectedFiles).toEqual(["a.ts"]);
  });
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

// ─── Clarification and coverage interleaving (US-012) ───────────────────────

/**
 * A branch-review reply whose verdict contradicts its findings: `spec: fail` with nothing blocking,
 * which the parser records as the `spec` mismatch.
 */
function mismatchJson(inspectedFiles: readonly string[]): string {
  return JSON.stringify({ spec: "fail", quality: "approved", inspectedFiles, findings: [], cannotVerify: [] });
}

const THREE_FILES: WorkflowBranchReviewInput = {
  ...input,
  requiredFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
};

/** Dispatch the op through real callOp, answering each turn with the next scripted reply. */
async function runReview(i: WorkflowBranchReviewInput, replies: readonly string[]): Promise<string[]> {
  const prompts: string[] = [];
  const agentManager = makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      assertDefined(req.executeHop, "req.executeHop");
      const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async (_agentName, handle, prompt): Promise<TurnResult> => {
      prompts.push(prompt);
      if (handle.id === "") throw new Error("the review session handle is required");
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
  await callOp(
    { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "_run" },
    workflowBranchReviewOp,
    i,
  );
  return prompts;
}

describe("workflowBranchReviewOp clarification and coverage interleaving (US-012)", () => {
  test("AC-11: the configured coverage allowance survives a clarification", () => {
    const strategy = strategyFor({ ...THREE_FILES, coverageRetries: 2 });
    expect(strategy.shouldRetry(probe, 0, retryCtx(mismatchJson([])))).toMatchObject({ retry: true });

    expect(strategy.shouldRetry(probe, 1, retryCtx(verdictJson([])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(input.range, ["src/a.ts", "src/b.ts", "src/c.ts"], false, {
        attempt: 1,
        max: 2,
      }),
    });
    // The second ask is still within the configured two, not a one-shot after the clarification.
    expect(strategy.shouldRetry(probe, 2, retryCtx(verdictJson(["src/a.ts"])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(input.range, ["src/b.ts", "src/c.ts"], false, {
        attempt: 2,
        max: 2,
      }),
    });
  });

  test("AC-12: a post-clarification coverage prompt keeps its diff-part references", () => {
    const parts = [{ path: "/run/package-branch-part-02.diff", files: ["src/a.ts"] }];
    const strategy = strategyFor({ ...input, requiredFiles: ["src/a.ts"], diffParts: parts });
    strategy.shouldRetry(probe, 0, retryCtx(mismatchJson([])));

    const decision = strategy.shouldRetry(probe, 1, retryCtx(verdictJson([])));

    expect(decision).toMatchObject({ retry: true });
    const nextPrompt = decision.retry ? decision.nextPrompt : undefined;
    expect(nextPrompt).toContain("- src/a.ts (package-branch-part-02.diff)");
  });

  test("AC-13: no-progress is measured only against responses to coverage prompts", () => {
    const strategy = strategyFor({ ...THREE_FILES, coverageRetries: 3 });
    expect(strategy.shouldRetry(probe, 0, retryCtx(verdictJson([])))).toMatchObject({ retry: true });
    // The reply at attempt 1 answers the coverage prompt but introduces a mismatch, so the
    // clarification — not coverage — is what follows it.
    expect(strategy.shouldRetry(probe, 1, retryCtx(mismatchJson([])))).toMatchObject({ retry: true });

    // This reply answers the clarification and covers no more files than the first one did; it is
    // not a coverage response, so it is neither a no-progress event nor a spent allowance.
    expect(strategy.shouldRetry(probe, 2, retryCtx(verdictJson([])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(input.range, ["src/a.ts", "src/b.ts", "src/c.ts"], false, {
        attempt: 2,
        max: 3,
      }),
    });
  });

  test("AC-14: a clarification response spends none of the coverage budget", () => {
    const strategy = strategyFor({ ...input, requiredFiles: ["src/a.ts"], coverageRetries: 1 });
    strategy.shouldRetry(probe, 0, retryCtx(mismatchJson([])));

    expect(strategy.shouldRetry(probe, 1, retryCtx(verdictJson([])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(input.range, ["src/a.ts"], false, { attempt: 1, max: 1 }),
    });
  });

  test("AC-15: a shape response cannot reset a spent coverage allowance", () => {
    const strategy = strategyFor({ ...input, requiredFiles: ["src/a.ts"], coverageRetries: 1 });
    strategy.shouldRetry(probe, 0, retryCtx(mismatchJson([])));
    expect(strategy.shouldRetry(probe, 1, retryCtx(verdictJson([])))).toMatchObject({ retry: true });
    // The JSON repair is the shape allowance, not a coverage one.
    expect(strategy.shouldRetry(probe, 2, retryCtx("not json"))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowReviewJsonRetry(),
    });

    const decision = strategy.shouldRetry(probe, 3, retryCtx(verdictJson([])));
    expect(decision.retry).toBe(false);
    expect(decision).toEqual({ retry: false, fallback: parseBranchReviewReply(verdictJson([]), []) });
  });

  test("AC-16: a stopped coverage state is not reopened by a restarted hop's shape response", () => {
    const strategy = strategyFor({ ...input, requiredFiles: ["src/a.ts", "src/b.ts"], coverageRetries: 3 });
    expect(strategy.shouldRetry(probe, 0, retryCtx(verdictJson([])))).toMatchObject({ retry: true });
    expect(strategy.shouldRetry(probe, 1, retryCtx(verdictJson([])))).toEqual({
      retry: false,
      fallback: parseBranchReviewReply(verdictJson([]), []),
    });

    // A manager-owned fallback hop restarts the loop at attempt 0 with a fresh session.
    expect(strategy.shouldRetry(probe, 0, retryCtx("not json"))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowReviewJsonRetry(),
    });
    // One more file read is progress by the old measure, but the stop holds for the invocation.
    expect(strategy.shouldRetry(probe, 1, retryCtx(verdictJson(["src/a.ts"])))).toEqual({
      retry: false,
      fallback: parseBranchReviewReply(verdictJson(["src/a.ts"]), []),
    });
  });

  test("AC-19: a coverage allowance of 2 sends 3+2 replies in one completed hop, and no more", async () => {
    const prompts = await runReview({ ...THREE_FILES, coverageRetries: 2 }, [
      "not json",
      mismatchJson([]),
      verdictJson(["src/a.ts"]),
      verdictJson(["src/a.ts", "src/b.ts"]),
      verdictJson(["src/a.ts", "src/b.ts", "src/c.ts"]),
    ]);

    expect(prompts).toHaveLength(5);
    expect(prompts[1]).toBe(buildWorkflowReviewJsonRetry());
    expect(prompts[2]).toContain("contradict each other");
    expect(prompts[3]).toContain("This is coverage retry 1 of 2.");
    expect(prompts[4]).toContain("This is coverage retry 2 of 2.");
  });
});

describe("workflowBranchReviewOp delivers the last parseable verdict (US-013)", () => {
  /** Dispatch the op through real callOp and return the verdict it delivered, plus the prompts sent. */
  async function deliveredVerdict(i: WorkflowBranchReviewInput, replies: readonly string[]) {
    const prompts: string[] = [];
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, prompt): Promise<TurnResult> => {
        prompts.push(prompt);
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
      i,
    );
    return { verdict, prompts };
  }

  test("AC-11: an inconsistent verdict followed by a malformed clarification and an exhausted repair is delivered", async () => {
    const { verdict, prompts } = await deliveredVerdict({ ...input, requiredFiles: [] }, [
      mismatchJson([]),
      "not json",
      "not json",
    ]);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("contradict each other");
    expect(prompts[2]).toBe(buildWorkflowReviewJsonRetry());
    expect(verdict).not.toBeNull();
    expect(verdict?.spec).toBe("fail");
  });

  test("AC-12: the delivered last-parseable verdict keeps its real findings", async () => {
    const { verdict, prompts } = await deliveredVerdict({ ...THREE_FILES, coverageRetries: 1 }, [
      verdictJson(["src/a.ts"], [IMPORTANT_FINDING]),
      "not json",
      "not json",
    ]);

    expect(prompts[1]).toContain("This is coverage retry 1 of 1.");
    expect(verdict).not.toBeNull();
    expect(verdict?.findings.map((finding) => finding.issue)).toEqual([IMPORTANT_FINDING.issue]);
  });

  test("AC-13: the delivered last-parseable verdict keeps the mismatch kinds it carried", async () => {
    const { verdict } = await deliveredVerdict({ ...THREE_FILES, coverageRetries: 1 }, [
      mismatchJson(THREE_FILES.requiredFiles),
      "not json",
      "not json",
    ]);

    expect(verdict).not.toBeNull();
    expect(verdict?.mismatch).toEqual(["spec"]);
  });
});

describe("workflowBranchReviewOp clarification is never suppressed by coverage (AC-18)", () => {
  test("an exhausted coverage budget still lets the clarification fire", () => {
    const strategy = strategyFor({ ...input, requiredFiles: ["src/a.ts"], coverageRetries: 0 });

    expect(strategy.shouldRetry(probe, 0, retryCtx(mismatchJson([])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchVerdictMismatchRetry(["spec"]),
    });
  });

  test("a stopped coverage state still lets the clarification fire", () => {
    const strategy = strategyFor({ ...input, requiredFiles: ["src/a.ts"], coverageRetries: 3 });
    expect(strategy.shouldRetry(probe, 0, retryCtx(verdictJson([])))).toMatchObject({ retry: true });
    // No progress: coverage stops here for the rest of the invocation.
    expect(strategy.shouldRetry(probe, 1, retryCtx(verdictJson([])))).toMatchObject({ retry: false });

    expect(strategy.shouldRetry(probe, 0, retryCtx(mismatchJson([])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchVerdictMismatchRetry(["spec"]),
    });
  });
});
